import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryJournalStore, type WorkflowDriver } from "@zcode/dynamic-workflow";
import { runWorkflowScript } from "./harness.js";

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocked.spawn }));
vi.mock("./child-entry-file.js", () => ({
  writeChildEntryFile: () => ({ path: "fixture.mjs" }),
}));

afterEach(() => vi.restoreAllMocks());

function fixture(aborted = false) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(() => true),
  });
  mocked.spawn.mockReturnValue(child as unknown as ChildProcess);
  const controller = new AbortController();
  if (aborted) controller.abort("interrupted");
  const journal = new InMemoryJournalStore();
  const driver: WorkflowDriver = {
    journal,
    async createActorSession() {
      throw new Error("unexpected actor");
    },
    startAsk() {},
    respondToSubmit() {},
    cancelAsk() {},
    async executeWorldRead() {},
    emit() {},
  };
  let completed = false;
  const result = runWorkflowScript({
    lowered: "return 1;",
    runId: "fixture",
    caps: { maxConcurrency: 1 },
    askSpecs: new Map(),
    validate: () => [],
    makeDriver: () => driver,
    signal: controller.signal,
  }).then((value) => {
    completed = true;
    return value;
  });
  return {
    child,
    controller,
    result,
    completed: () => completed,
    close() {
      child.exitCode = 0;
      child.emit("close", 0, null);
    },
    dispose() {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    },
  };
}

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("workflow settlement waits for owned sandbox close", () => {
  it.each(["complete", "abort", "already-aborted"])(
    "%s stays pending after kill until child close",
    async (kind) => {
      const f = fixture(kind === "already-aborted");
      try {
        if (kind === "complete")
          f.child.stdout.write(`${JSON.stringify({ kind: "complete", ok: true, value: 1 })}\n`);
        else if (kind === "abort") f.controller.abort("interrupted");
        await flush();
        expect(f.child.kill).toHaveBeenCalledOnce();
        expect(f.completed()).toBe(false);
        f.close();
        expect((await f.result).status).toBe(kind === "complete" ? "completed" : "stopped");
        expect(f.child.kill).toHaveBeenCalledOnce();
      } finally {
        f.close();
        await f.result;
        f.dispose();
      }
    },
  );

  it.each(["close", "error"])("child %s retains interrupted semantics", async (kind) => {
    const f = fixture();
    try {
      if (kind === "error") f.child.emit("error", new Error("fixture spawn error"));
      f.close();
      expect((await f.result).status).toBe("stopped");
      expect(f.completed()).toBe(true);
    } finally {
      f.close();
      f.dispose();
    }
  });
});
