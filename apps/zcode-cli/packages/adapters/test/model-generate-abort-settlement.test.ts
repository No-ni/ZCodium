import assert from "node:assert/strict";
import test from "node:test";
import { ModelErrorCode } from "@zcode/contracts";
import { runGenerateText } from "../src/model/runner-generate.js";
import { resolveAiSdkModelRetryOptions } from "../src/model/retry-policy.js";

// 根因（历史）：waitForGenerateTextOrAbort 先判断 signal.aborted 再注册 pending.then；
// 已 aborted 的早退分支直接 return，底层 provider promise 零 handler。Stop 落在
// model_request_started 状态发布的 await 窗口时，generateText 的迟到拒绝会成为
// unhandledRejection，而 CLI 进程级边界把 unhandledRejection 当致命错误。
// 本文件对真实 runGenerateText + fixture runtime 在 Node 默认严格拒绝模式下取证：
// 旧实现会因场景 1 无 handler 把子进程打成 uncaughtException（红）；修复后迟到
// fulfill/reject 始终被观察，且迟到 fulfill 不覆盖已发生的取消。

/** 事件 turn 驱动（setImmediate），不用 wall-clock 计时掩盖同步行为。 */
function eventTurns(count: number): Promise<void> {
  if (count <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    setImmediate(() => {
      void eventTurns(count - 1).then(resolve);
    });
  });
}

const resolved = {
  providerId: "fixture-provider",
  modelId: "fixture-model",
  providerKind: "google",
  properties: {},
  model: {},
  headers: {},
} as never;

const emptyResult = {
  text: "done",
  finishReason: "stop",
  providerMetadata: {},
  reasoning: [],
  toolCalls: [],
  toolResults: [],
  sources: [],
};

function makeInput(options: {
  abortController?: AbortController;
  calls: { count: number };
  generateText: () => Promise<unknown>;
  onPublish?: (event: { type: string }) => void;
  statuses: Array<{ type: string }>;
}) {
  return {
    env: {},
    resolved,
    resolveModel: () => resolved,
    request: {
      messages: [{ role: "user", content: "fixture" }],
      ...(options.abortController ? { abortSignal: options.abortController.signal } : {}),
    },
    retry: resolveAiSdkModelRetryOptions({ maxAttempts: 2, baseDelayMs: 1, jitter: false }, {}),
    statusSink: {
      publish: (event: { type: string }) => {
        options.statuses.push(event);
        options.onPublish?.(event);
      },
    },
    runtime: {
      generateText: () => {
        options.calls.count += 1;
        return options.generateText();
      },
    },
  };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as { code?: string }).code : undefined;
}

test("取消落在启动状态发布窗口：迟到拒绝被观察且归类为取消", async () => {
  const controller = new AbortController();
  const stopReason = new Error("user pressed stop");
  const providerRejection = new Error("provider aborted late");
  const calls = { count: 0 };
  const statuses: Array<{ type: string }> = [];
  const failure = await runGenerateText(
    makeInput({
      abortController: controller,
      calls,
      statuses,
      // Stop 精确落在 model_request_started 状态发布的 await 窗口内。
      onPublish: (event) => {
        if (event.type === "model_request_started") controller.abort(stopReason);
      },
      // 真正迟到的拒绝：若干事件 turn 后才 reject。
      generateText: async () => {
        await eventTurns(4);
        throw providerRejection;
      },
    }) as never,
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.equal(errorCode(failure), ModelErrorCode.ModelRequestCancelled);
  assert.equal(calls.count, 1, "取消不得重试");
  assert.ok(statuses.some((status) => status.type === "model_request_failed"));
  // 覆盖迟到拒绝发生的事件 turn：旧实现在此处于无 handler 状态，子进程转 uncaughtException。
  await eventTurns(8);
});

test("pre-abort 后迟到 fulfill 不覆盖已发生的取消", async () => {
  const controller = new AbortController();
  const stopReason = new Error("user pressed stop");
  const calls = { count: 0 };
  const statuses: Array<{ type: string }> = [];
  const failure = await runGenerateText(
    makeInput({
      abortController: controller,
      calls,
      statuses,
      onPublish: (event) => {
        if (event.type === "model_request_started") controller.abort(stopReason);
      },
      generateText: async () => {
        await eventTurns(4);
        return emptyResult;
      },
    }) as never,
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.equal(errorCode(failure), ModelErrorCode.ModelRequestCancelled);
  assert.equal(calls.count, 1);
  await eventTurns(8);
});

test("midflight abort 在有界事件 turn 内立即终结且迟到拒绝被观察", async () => {
  const controller = new AbortController();
  const stopReason = new Error("stop midflight");
  const lateRejection = new Error("provider rejected late");
  const calls = { count: 0 };
  const statuses: Array<{ type: string }> = [];
  const pending = runGenerateText(
    makeInput({
      abortController: controller,
      calls,
      statuses,
      // provider 直到第 6 个事件 turn 才拒绝；abort 在第 2 个 turn。
      generateText: () =>
        new Promise<unknown>((_, reject) => {
          void eventTurns(6).then(() => reject(lateRejection));
        }),
    }) as never,
  );
  void eventTurns(2).then(() => controller.abort(stopReason));
  const outcome = await Promise.race([
    pending.then(
      () => ({ settled: true as const }),
      () => ({ settled: true as const }),
    ),
    eventTurns(4).then(() => ({ settled: false as const })),
  ]);
  assert.equal(outcome.settled, true, "midflight abort 必须立即终结请求，不得等待 provider");
  const failure = await pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.equal(errorCode(failure), ModelErrorCode.ModelRequestCancelled);
  assert.equal(calls.count, 1);
  // 覆盖迟到拒绝（第 6 turn）：已注册观察消费，不致命。
  await eventTurns(8);
});

test("无 abortSignal 时成功语义不变", async () => {
  const calls = { count: 0 };
  const statuses: Array<{ type: string }> = [];
  const result = await runGenerateText(
    makeInput({
      calls,
      statuses,
      generateText: async () => emptyResult,
    }) as never,
  );
  assert.equal(result.text, "done");
  assert.equal(calls.count, 1);
  assert.ok(statuses.some((status) => status.type === "model_request_completed"));
});

test("无 abortSignal 时失败语义不变：归类且不重试", async () => {
  const calls = { count: 0 };
  const statuses: Array<{ type: string }> = [];
  const invalidResponse = Object.assign(new Error("invalid response"), {
    code: ModelErrorCode.InvalidModelResponse,
  });
  const failure = await runGenerateText(
    makeInput({
      calls,
      statuses,
      generateText: async () => {
        throw invalidResponse;
      },
    }) as never,
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.equal(errorCode(failure), ModelErrorCode.InvalidModelResponse);
  assert.equal(calls.count, 1);
  assert.ok(statuses.some((status) => status.type === "model_request_failed"));
});

test("signal 在场但从未 abort 时成功语义不变", async () => {
  const controller = new AbortController();
  const calls = { count: 0 };
  const statuses: Array<{ type: string }> = [];
  const result = await runGenerateText(
    makeInput({
      abortController: controller,
      calls,
      statuses,
      generateText: async () => {
        await eventTurns(2);
        return emptyResult;
      },
    }) as never,
  );
  assert.equal(result.text, "done");
  assert.equal(calls.count, 1);
});
