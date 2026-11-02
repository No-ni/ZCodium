import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { runStartRemoteConnection } from "../../packages/ui/src/remote-connection-flow/flowConnection.ts";
import { runResumeBackground } from "../../packages/ui/src/remote-connection-flow/flowRecovery.ts";

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

function connectionFixture() {
  const flight = deferred(),
    events = [];
  const context = {
    activeRequestIdRef: { current: null },
    entryEpochRef: { current: 0 },
    pendingCompletionIntentRef: { current: {} },
    minimizedRef: { current: false },
    ownsConnectedSessionRef: { current: false },
    pendingBackgroundCompletion: { current: null },
  };
  for (const key of [
    "setDirectoryPath",
    "setWorkspaceStepPath",
    "updatePendingRemoteTarget",
    "setLoading",
    "resetFeedback",
    "resetConnectionLogs",
    "setCurrentStep",
    "setRecognizedSourceServerId",
    "applySourceManagementSnapshot",
    "setRecognizedDeviceName",
    "setConnectedSessionId",
    "setBlockedCompletion",
    "setBackgroundReady",
    "setErrorCode",
    "setRawError",
    "setError",
    "onProjectIntentCleared",
    "applyOpenState",
  ])
    context[key] = (value) => events.push([key, value]);
  context.resolveWorkspaceStepPath = () => undefined;
  context.updateConnectingRequestId = (id) => {
    context.activeRequestIdRef.current = id;
    events.push(["request", Boolean(id)]);
  };
  context.onConnect = async () => {
    events.push(["connect"]);
    return flight.promise;
  };
  context.handleCancelSession = async (id) => {
    events.push(["release", id]);
  };
  context.onConnectionReady = async (id) => events.push(["ready", id]);
  return { context, flight, events };
}

test("连接入口同步占位，React 提交前双击只产生一次连接", async () => {
  const f = connectionFixture(),
    target = { kind: "ssh", host: "fixture.invalid", username: "fixture" };
  const first = runStartRemoteConnection(f.context, target);
  await runStartRemoteConnection(f.context, target);
  assert.equal(f.events.filter((e) => e[0] === "connect").length, 1);
  f.flight.resolve("fixture-session");
  await first;
  assert.deepEqual(
    f.events.filter((e) => e[0] === "ready"),
    [["ready", "fixture-session"]],
  );
  assert.equal(f.context.activeRequestIdRef.current, null);
});

test("关闭撤销 request 后，迟到连接只回收自己的 attachment", async () => {
  const f = connectionFixture();
  const first = runStartRemoteConnection(f.context, {
    kind: "ssh",
    host: "fixture.invalid",
    username: "fixture",
  });
  f.context.activeRequestIdRef.current = null;
  f.context.entryEpochRef.current++;
  const before = f.events.length;
  f.flight.resolve("fixture-stale-session");
  await first;
  assert.deepEqual(f.events.slice(before), [["release", "fixture-stale-session"]]);
});

test("后台继续先恢复前台门禁，再一次消费同一完成动作", async () => {
  const flight = deferred(),
    events = [];
  const context = {
    entryEpochRef: { current: 3 },
    minimizedRef: { current: true },
    pendingBackgroundCompletion: {
      current: async () => {
        events.push("finish");
        await flight.promise;
      },
    },
    handleOpenChange: () => events.push("open-again"),
    applyOpenState: () => events.push("open"),
    setBackgroundReady: () => events.push("ready-cleared"),
    setCompletionRunning: (busy) => events.push(["busy", busy]),
    setError: () => events.push("error"),
    setCurrentStep: () => events.push("step"),
  };
  runResumeBackground(context);
  runResumeBackground(context);
  assert.deepEqual(events.slice(0, 4), ["open", "ready-cleared", ["busy", true], "finish"]);
  assert.equal(events.filter((e) => e === "finish").length, 1);
  assert.equal(context.pendingBackgroundCompletion.current, null);
  flight.resolve();
  await setImmediate();
  assert.deepEqual(events.at(-1), ["busy", false]);
});

test("后台继续等待期间换代，旧失败不发布错误或清理新 busy", async () => {
  const flight = deferred(),
    events = [];
  const context = {
    entryEpochRef: { current: 3 },
    minimizedRef: { current: true },
    pendingBackgroundCompletion: { current: () => flight.promise },
    applyOpenState: () => {},
    setBackgroundReady: () => {},
    setCompletionRunning: (busy) => events.push(["busy", busy]),
    setError: () => events.push("error"),
    setCurrentStep: () => events.push("step"),
  };
  runResumeBackground(context);
  context.entryEpochRef.current++;
  flight.reject(Error("fixture failure"));
  await setImmediate();
  assert.deepEqual(events, [["busy", true]]);
});
