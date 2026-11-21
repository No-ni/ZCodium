import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteSessionStore } from "@zcode/adapters/storage";
import { prepareProtocolStartupStorage } from "../src/zcode-protocol/storage-startup.js";

afterEach(() => vi.restoreAllMocks());

function transport(reuse = false) {
  const input = new PassThrough();
  const frames: { method: string; params: { phase?: string } }[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      const frame = JSON.parse(String(chunk));
      frames.push(frame);
      if (frame.method === "startup/storagePath") {
        queueMicrotask(() =>
          input.write(JSON.stringify({ method: "startup/storagePathReady", reuse }) + "\n"),
        );
      }
      callback();
    },
  });
  return {
    input,
    output,
    frames,
    dispose() {
      input.destroy();
      output.destroy();
    },
  };
}

const failures = [
  { name: "undefined", value: undefined },
  { name: "null", value: null },
  { name: "false", value: false },
  { name: "zero", value: 0 },
  { name: "empty string", value: "" },
  { name: "Error", value: new Error("fixture original failure") },
];

describe("存储准备清理保持原始失败优先级", () => {
  it.each(failures)("$name 不被二次 close 错误覆盖", async ({ value }) => {
    const t = transport();
    const close = vi
      .fn()
      .mockImplementationOnce(() => {
        throw value;
      })
      .mockImplementationOnce(() => {
        throw new Error("fixture cleanup failure");
      });
    vi.spyOn(SqliteSessionStore, "openStartup").mockResolvedValue({
      close,
    } as unknown as SqliteSessionStore);
    try {
      const result = await prepareProtocolStartupStorage({
        dbPath: join(tmpdir(), "fixture-cleanup", "db.sqlite"),
        input: t.input,
        output: t.output,
      }).then(
        () => ({ failed: false }),
        (error: unknown) => ({ failed: true, error }),
      );
      expect(result).toEqual({ failed: true, error: value });
      if ("error" in result) expect(result.error).toBe(value);
      expect(close).toHaveBeenCalledTimes(2);
      expect(t.frames.some((f) => f.method === "startup/storagePrepared")).toBe(false);
      expect(t.frames.filter((f) => f.params.phase === "failed")).toHaveLength(1);
    } finally {
      t.dispose();
    }
  });

  it.each([false, true])("正常准备 reuse=%s 保持唯一连接所有者", async (reuse) => {
    const t = transport(reuse);
    const close = vi.fn();
    const open = vi
      .spyOn(SqliteSessionStore, "openStartup")
      .mockResolvedValue({ close } as unknown as SqliteSessionStore);
    try {
      await expect(
        prepareProtocolStartupStorage({
          dbPath: join(tmpdir(), "fixture-cleanup", "db.sqlite"),
          input: t.input,
          output: t.output,
        }),
      ).resolves.toBeUndefined();
      expect(open).toHaveBeenCalledTimes(reuse ? 0 : 1);
      expect(close).toHaveBeenCalledTimes(reuse ? 0 : 1);
      expect(t.frames.filter((f) => f.method === "startup/storagePrepared")).toHaveLength(1);
      expect(t.frames.some((f) => f.params.phase === "failed")).toBe(false);
    } finally {
      t.dispose();
    }
  });
});
