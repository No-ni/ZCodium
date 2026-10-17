import { execFile } from "node:child_process";
import { getEventListeners } from "node:events";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZCodeStorageStartupState } from "@zcode/shared";
import { ZCodeStorageStartupGate } from "../src/zcode-agent/zcodeStorageStartupGate.js";

const gates: ZCodeStorageStartupGate[] = [];
function fixture(required = true, firstStatusTimeoutMs = 30_000) {
  const gate = new ZCodeStorageStartupGate(required, firstStatusTimeoutMs);
  gates.push(gate);
  return gate;
}

function state(phase: ZCodeStorageStartupState["phase"], sequence = 1): ZCodeStorageStartupState {
  return {
    schemaVersion: 1,
    attemptId: "synthetic-attempt",
    databaseId: "synthetic-database",
    databaseKind: "session",
    sequence,
    phase,
    elapsedMs: sequence,
    ...(phase === "failed" ? { errorCode: "sql_failed" } : {}),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const gate of gates.splice(0)) gate.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("startup waiter resource lifetime", () => {
  it("releases cancelled reasons while the gate remains migrating", async () => {
    // 在自己的子进程启用 GC，不改 Vitest/用户 Node 选项，不启动 Agent 或读写数据库。
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--expose-gc",
        "--import",
        "tsx",
        fileURLToPath(new URL("./fixtures/storageStartupRetention.mjs", import.meta.url)),
      ],
      { cwd: fileURLToPath(new URL("../../../", import.meta.url)), windowsHide: true },
    );
    expect(JSON.parse(stdout)).toEqual({
      cancelled: 128,
      retainedWhileWaiting: 0,
      retainedAfterReady: 0,
    });
  });

  it.each([new Error("cancelled"), "cancelled", null, 0])(
    "preserves the original abort reason %j and keeps the gate closed",
    async (reason) => {
      const gate = fixture();
      const controller = new AbortController();
      const outcome = gate.wait(controller.signal).catch((error: unknown) => error);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
      controller.abort(reason);
      expect(await outcome).toBe(reason);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      expect(gate.isWaiting).toBe(true);
      const next = gate.wait();
      expect(gate.accept(state("ready"))).toBe(true);
      await expect(next).resolves.toBeUndefined();
    },
  );

  it("pre-aborted calls never register and take priority over ready or failure", async () => {
    const gate = fixture();
    const controller = new AbortController();
    const reason = new Error("already cancelled");
    controller.abort(reason);
    await expect(gate.wait(controller.signal)).rejects.toBe(reason);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    gate.accept(state("ready"));
    await expect(gate.wait(controller.signal)).rejects.toBe(reason);
    const failed = fixture();
    failed.accept(state("failed"));
    await expect(failed.wait(controller.signal)).rejects.toBe(reason);
  });

  it.each(["ready", "failed", "dispose", "timeout"] as const)(
    "%s settles only active mixed waiters and removes all abort listeners",
    async (completion) => {
      const gate = fixture();
      const controllers = Array.from({ length: 6 }, () => new AbortController());
      const outcomes = controllers.map((controller) =>
        gate.wait(controller.signal).catch((error: unknown) => error),
      );
      const withoutSignal = gate.wait().catch((error: unknown) => error);
      const reason = new Error("cancelled independently");
      controllers[2]!.abort(reason);
      expect(await outcomes[2]).toBe(reason);
      if (completion === "ready") gate.accept(state("ready"));
      if (completion === "failed") gate.accept(state("failed"));
      if (completion === "dispose") gate.dispose();
      if (completion === "timeout") vi.advanceTimersByTime(30_000);
      const values = await Promise.all(outcomes);
      for (const [index, value] of values.entries()) {
        if (index === 2) expect(value).toBe(reason);
        else if (completion === "ready") expect(value).toBeUndefined();
        else {
          const code =
            completion === "failed"
              ? "sql_failed"
              : completion === "dispose"
                ? "transport_closed"
                : "startup_status_timeout";
          expect(value).toEqual(new Error(`SQLite startup failed: ${code}`));
          expect(value).toBe(values[0]);
        }
      }
      expect(await withoutSignal).toBe(values[0]);
      for (const controller of controllers) {
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
        controller.abort(new Error("late cancellation"));
      }
      expect(await Promise.all(outcomes)).toEqual(values);
      expect(vi.getTimerCount()).toBe(0);
      expect(gate.isWaiting).toBe(completion !== "ready");
      if (completion === "ready") await expect(gate.wait()).resolves.toBeUndefined();
      else await expect(gate.wait()).rejects.toBe(values[0]);
    },
  );

  it("cancels one shared-signal group without disturbing other callers", async () => {
    const gate = fixture();
    const controller = new AbortController();
    const outcomes = Array.from({ length: 4 }, () =>
      gate.wait(controller.signal).catch((error: unknown) => error),
    );
    const active = gate.wait();
    const reason = new Error("group cancelled");
    controller.abort(reason);
    expect(await Promise.all(outcomes)).toEqual([reason, reason, reason, reason]);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    gate.accept(state("ready"));
    await expect(active).resolves.toBeUndefined();
  });
});

describe("startup gate state and notification contract", () => {
  it("optional startup allows early requests then gates on valid progress without a timer", async () => {
    const gate = fixture(false);
    expect(gate.isWaiting).toBe(false);
    await expect(gate.wait()).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(gate.accept(state("checking"))).toBe(true);
    expect(gate.isWaiting).toBe(true);
    const outcome = gate.wait();
    gate.accept(state("ready", 2));
    await outcome;
    gate.dispose();
    await expect(gate.wait()).resolves.toBeUndefined();
  });

  it("only valid first progress clears the timeout and progress never releases waiters", async () => {
    const gate = fixture();
    let settled = false;
    const outcome = gate.wait().then(() => {
      settled = true;
    });
    expect(gate.accept({ ...state("checking"), unexpected: true })).toBe(false);
    expect(gate.accept({ ...state("checking"), sequence: 0 })).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    gate.accept(state("waiting_for_lock"));
    expect(vi.getTimerCount()).toBe(0);
    gate.accept(state("migrating", 2));
    gate.accept(state("committing", 3));
    vi.advanceTimersByTime(300_000);
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.accept(state("ready", 4));
    await outcome;
    expect(settled).toBe(true);
  });

  it("rejects stale, foreign and terminal-regression frames without notifying", async () => {
    const gate = fixture();
    const changed = vi.fn();
    gate.onDidChange(changed);
    const current = state("migrating", 2);
    gate.accept(current);
    for (const frame of [
      state("ready", 1),
      state("ready", 2),
      { ...state("ready", 3), attemptId: "other-attempt" },
      { ...state("ready", 3), databaseId: "other-database" },
    ])
      expect(gate.accept(frame)).toBe(false);
    expect(gate.snapshot).toEqual(current);
    expect(changed).toHaveBeenCalledTimes(1);
    gate.accept(state("ready", 3));
    expect(gate.accept(state("failed", 4))).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
    await expect(gate.wait()).resolves.toBeUndefined();
  });

  it.each(["failed", "timeout", "dispose"] as const)(
    "remembers %s without callers and refuses later ready frames",
    async (completion) => {
      const gate = fixture();
      if (completion === "failed") gate.accept(state("failed"));
      if (completion === "timeout") vi.advanceTimersByTime(30_000);
      if (completion === "dispose") gate.dispose();
      expect(gate.snapshot?.phase).toBe("failed");
      expect(gate.snapshot?.databaseId).toBeTruthy();
      expect(gate.accept(state("ready", 2))).toBe(false);
      await expect(gate.wait()).rejects.toThrow("SQLite startup failed:");
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["ready", "failed", "timeout"] as const)(
    "settles callers created reentrantly by %s notifications",
    async (completion) => {
      const gate = fixture();
      const controller = new AbortController();
      let nested: Promise<unknown> | undefined;
      gate.onDidChange((next) => {
        if (next.phase === "ready" || next.phase === "failed") {
          nested = gate.wait(controller.signal).catch((error: unknown) => error);
        }
      });
      const first = gate.wait().catch((error: unknown) => error);
      if (completion === "timeout") vi.advanceTimersByTime(30_000);
      else gate.accept(state(completion));
      expect(nested).toBeDefined();
      expect(await nested).toBe(await first);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    },
  );
});
