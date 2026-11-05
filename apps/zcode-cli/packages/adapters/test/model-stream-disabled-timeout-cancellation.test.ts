import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { ModelErrorCode } from "@zcode/contracts";
import {
  isModelStreamIdleTimeoutError,
  readNextWithStreamIdleTimeout,
} from "../src/model/stream-idle-timeout.js";
import { runStreamText } from "../src/model/runner-stream.js";
import { resolveAiSdkModelRetryOptions } from "../src/model/retry-policy.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function eventTurns(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await setImmediate();
}

for (const timeoutMs of [0, -1, NaN, Infinity]) {
  test(`idle timeout=${timeoutMs} 时 Provider 不结算也能立即取消`, async () => {
    const provider = deferred<IteratorResult<string>>();
    const controller = new AbortController();
    const reason = new Error("fixture stop");
    let settled = false;
    const outcome = readNextWithStreamIdleTimeout(
      { next: () => provider.promise },
      {
        abortController: controller,
        timeoutMs,
      },
    ).then(
      (value) => {
        settled = true;
        return { value };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      },
    );
    controller.abort(reason);
    await eventTurns();
    const cancelledBeforeProviderSettlement = settled;
    // 旧实现挂在 next；先结算 fixture，保证红测试也不会遗留未决调用。
    provider.reject(new Error("late provider rejection"));
    const result = await outcome;
    assert.equal(cancelledBeforeProviderSettlement, true);
    assert.equal("error" in result ? result.error : undefined, reason);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });
}

test("禁用计时且调用前已 abort 时仍拒绝取消并观察迟到 Provider 拒绝", async () => {
  const provider = deferred<IteratorResult<string>>();
  const controller = new AbortController();
  const reason = new Error("fixture already stopped");
  controller.abort(reason);
  let settled = false;
  const outcome = readNextWithStreamIdleTimeout(
    { next: () => provider.promise },
    {
      abortController: controller,
      timeoutMs: 0,
    },
  ).catch((error: unknown) => {
    settled = true;
    return error;
  });
  await eventTurns();
  const cancelledBeforeProviderSettlement = settled;
  provider.reject(new Error("late provider rejection"));
  assert.equal(await outcome, reason);
  assert.equal(cancelledBeforeProviderSettlement, true);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("禁用计时的自然结算保持原结果并清理监听", async () => {
  const controller = new AbortController();
  const value = { done: false as const, value: "fixture" };
  assert.equal(
    await readNextWithStreamIdleTimeout(
      { next: async () => value },
      {
        abortController: controller,
        timeoutMs: 0,
      },
    ),
    value,
  );
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

for (const timeoutMs of [0, 60_000]) {
  test(`idle timeout=${timeoutMs} 的 pre-abort 优先于已成功的 next`, async () => {
    const controller = new AbortController();
    const reason = new Error("fixture already stopped");
    controller.abort(reason);
    await assert.rejects(
      readNextWithStreamIdleTimeout(
        {
          next: () => Promise.resolve({ done: false, value: "fixture" }),
        },
        { abortController: controller, timeoutMs },
      ),
      (actual: unknown) => actual === reason,
    );
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });

  test(`idle timeout=${timeoutMs} 的 pre-abort 优先于 next 同步抛错`, async () => {
    const controller = new AbortController();
    const reason = new Error("fixture already stopped");
    controller.abort(reason);
    await assert.rejects(
      readNextWithStreamIdleTimeout(
        {
          next: () => {
            throw new Error("fixture sync failure");
          },
        },
        { abortController: controller, timeoutMs },
      ),
      (actual: unknown) => actual === reason,
    );
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });
}

test("禁用计时的 Provider 失败保持原错误并清理监听", async () => {
  const controller = new AbortController();
  const error = new Error("fixture provider failure");
  await assert.rejects(
    readNextWithStreamIdleTimeout(
      {
        next: async () => {
          throw error;
        },
      },
      {
        abortController: controller,
        timeoutMs: 0,
      },
    ),
    (actual: unknown) => actual === error,
  );
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("启用计时仍立即响应 abort 并清理监听", async () => {
  const provider = deferred<IteratorResult<string>>();
  const controller = new AbortController();
  const reason = new Error("fixture stop");
  const assertion = assert.rejects(
    readNextWithStreamIdleTimeout(
      { next: () => provider.promise },
      {
        abortController: controller,
        timeoutMs: 60_000,
      },
    ),
    (actual: unknown) => actual === reason,
  );
  controller.abort(reason);
  await assertion;
  provider.reject(new Error("late provider rejection"));
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("启用计时的空闲 timeout 仍 abort 并且仅发布一次 stall", async () => {
  const provider = deferred<IteratorResult<string>>();
  const controller = new AbortController();
  let stalls = 0;
  await assert.rejects(
    readNextWithStreamIdleTimeout(
      { next: () => provider.promise },
      {
        abortController: controller,
        onTimeout: () => {
          stalls += 1;
        },
        timeoutMs: 1,
      },
    ),
    isModelStreamIdleTimeoutError,
  );
  provider.reject(new Error("late provider rejection"));
  assert.equal(stalls, 1);
  assert.equal(controller.signal.aborted, true);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("runStreamText 禁用计时时 Stop 不等待 Provider、终态取消且不重试", async () => {
  const provider = deferred<IteratorResult<never>>();
  const nextEntered = deferred<void>();
  const controller = new AbortController();
  const statuses: Array<{ type: string; reason?: string }> = [];
  let providerCalls = 0;
  let iteratorCloses = 0;
  let admissionReleases = 0;
  const resolved = {
    providerId: "fixture-provider",
    modelId: "fixture-model",
    providerKind: "google",
    properties: {},
    model: {},
    headers: {},
  } as never;
  const stream = runStreamText({
    env: {},
    resolved,
    resolveModel: () => resolved,
    request: {
      messages: [{ role: "user", content: "fixture" }],
      abortSignal: controller.signal,
      modelRequestAdmission: {
        acquire: async () => ({
          publish() {},
          release: () => {
            admissionReleases += 1;
          },
        }),
      },
    },
    retry: resolveAiSdkModelRetryOptions({ maxAttempts: 2, baseDelayMs: 1, jitter: false }, {}),
    streamIdleTimeoutMs: 0,
    statusSink: {
      publish: (event: { type: string; reason?: string }) => {
        statuses.push(event);
      },
    },
    runtime: {
      streamText: () => {
        providerCalls += 1;
        return {
          fullStream: {
            [Symbol.asyncIterator]: () => ({
              next: () => {
                nextEntered.resolve();
                return provider.promise;
              },
              return: async () => {
                iteratorCloses += 1;
                return { done: true };
              },
            }),
          },
        };
      },
    },
  } as never);
  let settled = false;
  const outcome = stream.next().then(
    (value) => {
      settled = true;
      return { value };
    },
    (error: unknown) => {
      settled = true;
      return { error };
    },
  );
  await nextEntered.promise;
  controller.abort(new Error("fixture stop"));
  await eventTurns();
  const cancelledBeforeProviderSettlement = settled;
  provider.reject(new Error("late provider rejection"));
  const result = await outcome;
  assert.equal(cancelledBeforeProviderSettlement, true);
  assert.ok("error" in result);
  assert.equal((result.error as { code: string }).code, ModelErrorCode.ModelRequestCancelled);
  assert.equal(providerCalls, 1);
  assert.equal(iteratorCloses, 1);
  assert.equal(admissionReleases, 1);
  assert.deepEqual(
    statuses.filter((event) => event.type === "model_request_failed").map((event) => event.reason),
    ["cancelled"],
  );
  assert.equal(
    statuses.some(
      (event) =>
        event.type === "model_retry_scheduled" ||
        event.type === "model_stream_stalled" ||
        event.type === "model_request_completed",
    ),
    false,
  );
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
