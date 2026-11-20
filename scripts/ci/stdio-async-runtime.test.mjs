import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { startStdioProcess } from "../../packages/server/src/stdio-lifecycle.ts";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("shutdown during async runtime creation disposes the late runtime before exit", async () => {
  const signals = new EventEmitter();
  const stdin = new PassThrough();
  const pending = deferred();
  const entered = deferred();
  const exited = deferred();
  const events = [];
  const startup = startStdioProcess({
    stdin,
    signalSource: signals,
    log() {},
    prepare: async () => "prepared",
    createRuntime: async () => {
      entered.resolve();
      await pending.promise;
      return {
        stopRpc: async () => {
          events.push("stop");
        },
        dispose: async () => {
          events.push("dispose");
        },
        ready: () => {
          events.push("runtime-ready");
        },
      };
    },
    ready: () => {
      events.push("ready");
    },
    exit: (code) => {
      events.push(`exit-${code}`);
      exited.resolve();
    },
  });
  await entered.promise;
  signals.emit("SIGTERM");
  await Promise.resolve();
  assert.deepEqual(events, []);
  pending.resolve();
  await startup;
  await exited.promise;
  assert.deepEqual(events, ["stop", "dispose", "exit-1"]);
  stdin.destroy();
});

test("async runtime rejection exits without publishing ready", async () => {
  const events = [];
  const stdin = new PassThrough();
  await startStdioProcess({
    stdin,
    signalSource: new EventEmitter(),
    log() {},
    prepare: async () => undefined,
    createRuntime: async () => {
      throw new Error("fixture-failure");
    },
    ready: () => {
      events.push("ready");
    },
    exit: (code) => {
      events.push(`exit-${code}`);
    },
  });
  assert.deepEqual(events, ["exit-1"]);
  stdin.destroy();
});

test("async startup publishes ready after the runtime is registered", async () => {
  const events = [];
  const stdin = new PassThrough();
  await startStdioProcess({
    stdin,
    signalSource: new EventEmitter(),
    log() {},
    prepare: async () => undefined,
    createRuntime: async () => ({
      stopRpc: async () => {},
      dispose: async () => {},
      ready: () => {
        events.push("runtime-ready");
      },
    }),
    ready: () => {
      events.push("ready");
    },
    exit: () => {},
  });
  assert.deepEqual(events, ["runtime-ready", "ready"]);
  stdin.destroy();
});
