import { getEventListeners } from "node:events";
import assert from "node:assert/strict";
import test from "node:test";
import { runGenerateText } from "../src/model/runner-generate.js";
import { sleep } from "../src/model/runner-retry.js";
import { resolveAiSdkModelRetryOptions } from "../src/model/retry-policy.js";

// 根因（历史）：runner-retry.ts 的 sleep 只在 abort 真实触发时靠 {once:true} 自移除监听，
// 退避正常睡满后不 removeEventListener。同一轮 turn 的每个 model step 复用同一个
// AbortSignal（core turn-model-step 传 state.turnAbortSignal），每次重试退避都在该 signal 上
// 永久残留一个持有已触发 Timer 与已 settle Promise 的闭包，轮内单调累积。
// 本文件直接对生产 sleep 与真实 generateText 空完成重试路径断言监听生命周期。

function abortListenerCount(signal: AbortSignal): number {
  return getEventListeners(signal, "abort").length;
}

test("退避正常睡满后同一 signal 不残留 abort 监听", async () => {
  const controller = new AbortController();
  for (let i = 0; i < 12; i += 1) {
    await sleep(1, controller.signal);
    assert.equal(abortListenerCount(controller.signal), 0, `after normal sleep #${i + 1}`);
  }
});

test("退避中被 abort 立即以 signal.reason 拒绝且监听归零", async () => {
  const controller = new AbortController();
  const reason = new Error("user pressed stop");
  const pending = sleep(60_000, controller.signal);
  controller.abort(reason);
  await assert.rejects(pending, (error: unknown) => error === reason);
  assert.equal(abortListenerCount(controller.signal), 0);
});

test("退避中被 abort 时清除未决 timer", async () => {
  const originalClearTimeout = globalThis.clearTimeout;
  let clearTimeoutCalls = 0;
  globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
    clearTimeoutCalls += 1;
    return originalClearTimeout(handle);
  }) as typeof globalThis.clearTimeout;
  try {
    const controller = new AbortController();
    const pending = sleep(60_000, controller.signal);
    controller.abort(new Error("user pressed stop"));
    await assert.rejects(pending);
    assert.ok(clearTimeoutCalls >= 1, `expected clearTimeout on abort, got ${clearTimeoutCalls}`);
  } finally {
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("调用前已 abort 的退避立即以 signal.reason 拒绝", async () => {
  const controller = new AbortController();
  const reason = new Error("already stopped");
  controller.abort(reason);
  await assert.rejects(sleep(10, controller.signal), (error: unknown) => error === reason);
  assert.equal(abortListenerCount(controller.signal), 0);
});

test("无 abortSignal 的退避正常结束", async () => {
  await sleep(1);
});

test("delayMs 非正的退避保持立即返回", async () => {
  await sleep(0);
  await sleep(-5);
});

test("delayMs 非正且已 abort 时仍以 signal.reason 拒绝", async () => {
  const controller = new AbortController();
  const reason = new Error("already stopped");
  controller.abort(reason);
  await assert.rejects(sleep(0, controller.signal), (error: unknown) => error === reason);
});

test("signal.reason 不是 Error 时拒绝 AbortError 形状的错误", async () => {
  const controller = new AbortController();
  controller.abort("stop");
  await assert.rejects(sleep(10, controller.signal), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as Error).name, "AbortError");
    return true;
  });
});

test("generateText 空完成重试的退避结束后请求 signal 不残留监听", async () => {
  const abortController = new AbortController();
  const statuses: Array<{ type: string }> = [];
  // 空完成判定要求 usage 为零（totalTokens===0）；第一次 attempt 不带 usage 才能进入重试。
  const emptyResult = {
    text: "",
    finishReason: "other",
    providerMetadata: {},
    reasoning: [],
    toolCalls: [],
    toolResults: [],
    sources: [],
  };
  const contentResult = { ...emptyResult, text: "done", finishReason: "stop" };
  let calls = 0;
  const resolved = {
    providerId: "fixture-provider",
    modelId: "fixture-model",
    providerKind: "google",
    properties: {},
    model: {},
    headers: {},
  } as never;
  const result = await runGenerateText({
    env: {},
    resolved,
    resolveModel: () => resolved,
    request: {
      messages: [{ role: "user", content: "fixture" }],
      abortSignal: abortController.signal,
    },
    retry: resolveAiSdkModelRetryOptions({ maxAttempts: 2, baseDelayMs: 1, jitter: false }, {}),
    statusSink: {
      publish: (event: { type: string }) => {
        statuses.push(event);
      },
    },
    runtime: {
      generateText: async () => {
        calls += 1;
        return calls === 1 ? emptyResult : contentResult;
      },
    },
  } as never);
  assert.equal(result.text, "done");
  assert.equal(calls, 2);
  assert.ok(statuses.some((status) => status.type === "model_retry_scheduled"));
  // 退避 sleep 正常结束后，请求 signal 上不得遗留任何 abort 监听。
  assert.equal(abortListenerCount(abortController.signal), 0);
});
