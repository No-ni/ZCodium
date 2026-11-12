import assert from "node:assert/strict";
import test from "node:test";
import { getModelUsageTotalTokens } from "@zcode/contracts";
import { prepareNativeContext } from "../src/runtime/native-context-compression/index.js";
import {
  compressNativeContext,
  setNativeContextPolicy,
} from "../src/runtime/native-context-compression/controller.js";
import { kernelOf } from "../src/runtime/native-context-compression/state.js";
import { PARENT } from "./native-context-boundary-fixture.js";
import {
  chargedFailure,
  deferred,
  summaryResult,
  USAGE,
} from "./native-context-maintenance-fixture.js";
import { maintenanceGoalFixture, MAIN_USAGE } from "./native-context-maintenance-goal-fixture.js";

for (const status of ["paused", "budget_limited"] as const) {
  test(status + " Goal prevents a payable automatic native safe point", async (t) => {
    const f = await maintenanceGoalFixture(t, { automatic: true, status });
    await prepareNativeContext(f.runtime, f.safePoint());
    const goal = await f.store.readTarget({ sessionID: PARENT });
    const usage = await f.store.queryTaskUsage({ sessionID: PARENT });
    assert.deepEqual(
      {
        physicalRequests: f.calls.length,
        taskRequests: usage.modelRequestCount,
        goalStatus: goal?.status,
        goalTokens: goal?.tokensUsed,
      },
      {
        physicalRequests: 0,
        taskRequests: 0,
        goalStatus: status,
        goalTokens: f.goal.tokensUsed,
      },
    );
    assert.equal((await f.observations()).length, 0);
    assert.equal(kernelOf(f.owner.state!).compression.blocks.length, 0);
    assert.equal(f.owner.phase, "idle");
  });

  test(
    status + " Goal cannot be bypassed by an explicit idle native maintenance command",
    async (t) => {
      const f = await maintenanceGoalFixture(t, { status });
      // 规范未固定拒绝时的返回形状；此处仅验证付费门禁与不隐式恢复 Goal。
      await Promise.allSettled([f.manual("native-goal-blocked-manual")]);
      const goal = await f.store.readTarget({ sessionID: PARENT });
      const usage = await f.store.queryTaskUsage({ sessionID: PARENT });
      assert.deepEqual(
        {
          physicalRequests: f.calls.length,
          taskRequests: usage.modelRequestCount,
          goalStatus: goal?.status,
          goalTokens: goal?.tokensUsed,
        },
        {
          physicalRequests: 0,
          taskRequests: 0,
          goalStatus: status,
          goalTokens: f.goal.tokensUsed,
        },
      );
      assert.equal(f.owner.phase, "idle");
      assert.equal(f.runtime.runtimeCommandQueue.size(), 0);
    },
  );
}

test("a real foreground turn charges native automatic maintenance to its existing Goal owner exactly once", async (t) => {
  const f = await maintenanceGoalFixture(t, { automatic: true });
  const inputID = "native-goal-real-foreground";
  const startedAtMs = Date.now();
  const result = await f.runtime.executeTurnCommand("Synthetic current Goal request.", undefined, {
    inputId: inputID,
    skipUserPromptSubmitHooks: true,
    traceContext: f.runtime.rootTraceContext,
  });
  assert.equal(
    f.invocations.filter((item) => item.querySource === "native_context_maintenance").length,
    1,
  );
  assert.equal(
    f.invocations.filter((item) => item.querySource !== "native_context_maintenance").length,
    1,
  );
  const goal = await f.store.readTarget({ sessionID: PARENT });
  const usage = await f.store.queryTaskUsage({ sessionID: PARENT });
  const expected = getModelUsageTotalTokens(USAGE) + getModelUsageTotalTokens(MAIN_USAGE);
  await f.runtime.accountTargetTurnCompletion({
    inputID,
    startedAtMs,
    startedTarget: f.goal,
    traceContext: f.runtime.rootTraceContext,
    usage: result.usage,
  });
  const replayed = await f.store.readTarget({ sessionID: PARENT });
  assert.deepEqual(
    {
      taskRequests: usage.modelRequestCount,
      taskTokens: usage.inputTokens + usage.outputTokens,
      goalTokens: goal?.tokensUsed,
      replayedTokens: replayed?.tokensUsed,
      activeInputId: replayed?.activeInputId,
    },
    {
      taskRequests: 2,
      taskTokens: expected,
      goalTokens: expected,
      replayedTokens: expected,
      activeInputId: null,
    },
  );
});

test("successful idle native maintenance charges its active Goal once across admission replay and durable receipt lookup", async (t) => {
  const f = await maintenanceGoalFixture(t);
  const commandId = "native-goal-manual-success";
  const admitted = await f.manual(commandId);
  const original = await f.store.getNativeContextOperation(PARENT, admitted.operation!.operationId);
  assert.equal(original?.status, "completed");
  await f.manual(commandId);
  await f.replayManual(commandId);
  const usage = await f.store.queryTaskUsage({ sessionID: PARENT });
  const goal = await f.store.readTarget({ sessionID: PARENT });
  assert.deepEqual(
    {
      physicalRequests: f.calls.length,
      taskRequests: usage.modelRequestCount,
      goalTokens: goal?.tokensUsed,
    },
    { physicalRequests: 1, taskRequests: 1, goalTokens: getModelUsageTotalTokens(USAGE) },
  );
  assert.equal(usage.inputTokens, USAGE.inputTokens);
  assert.equal(usage.outputTokens, USAGE.outputTokens);
});

test("a started native maintenance cancellation preserves paid usage in its Goal without charging a replay", async (t) => {
  const started = deferred();
  const f = await maintenanceGoalFixture(t, {
    plan: async ({ request }) => {
      started.resolve();
      await new Promise<void>((resolve) => {
        if (request.abortSignal?.aborted) resolve();
        else request.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw chargedFailure({ inputTokens: 12, outputTokens: 0, cacheReadTokens: 0 });
    },
  });
  const abort = new AbortController();
  const commandId = "native-goal-charged-cancel";
  f.runtime.runtimeCommandDrainActive = true;
  const ack = await compressNativeContext.call(f.runtime, f.input(commandId, abort));
  f.runtime.runtimeCommandDrainActive = false;
  const pending = f.runtime.drainRuntimeCommandQueue();
  const reachedModel = await Promise.race([
    started.promise.then(() => true),
    pending.then(() => false),
  ]);
  assert.equal(reachedModel, true);
  abort.abort(new Error("Synthetic user stop."));
  await pending;
  const original = await f.store.getNativeContextOperation(PARENT, ack.operation!.operationId);
  assert.equal(original?.status, "cancelled");
  await f.replayManual(commandId);
  const usage = await f.store.queryTaskUsage({ sessionID: PARENT });
  const goal = await f.store.readTarget({ sessionID: PARENT });
  assert.deepEqual(
    {
      physicalRequests: f.calls.length,
      taskRequests: usage.modelRequestCount,
      taskTokens: usage.inputTokens + usage.outputTokens,
      goalTokens: goal?.tokensUsed,
    },
    { physicalRequests: 1, taskRequests: 1, taskTokens: 12, goalTokens: 12 },
  );
  assert.equal((await f.observations())[0]?.actualInputTokens, 12);
  assert.equal((await f.observations())[0]?.outputTokens, 0);
});

test("an in-flight policy update rejects the late native summary while charging its reported Goal usage only once", async (t) => {
  const started = deferred(),
    release = deferred();
  t.after(() => release.resolve());
  const f = await maintenanceGoalFixture(t, {
    plan: async ({ request }) => {
      started.resolve();
      await release.promise;
      return { text: summaryResult(request.messages) };
    },
  });
  const commandId = "native-goal-policy-obsolete";
  f.runtime.runtimeCommandDrainActive = true;
  const ack = await compressNativeContext.call(f.runtime, f.input(commandId));
  f.runtime.runtimeCommandDrainActive = false;
  const pending = f.runtime.drainRuntimeCommandQueue();
  const reachedModel = await Promise.race([
    started.promise.then(() => true),
    pending.then(() => false),
  ]);
  assert.equal(reachedModel, true);
  const { policyVersion, ...configuration } = structuredClone(f.owner.state!.policy);
  configuration.parameters.summary.minReductionPercent += 1;
  await setNativeContextPolicy.call(f.runtime, {
    configuration,
    expectedPolicyVersion: policyVersion,
    commandId: "native-goal-policy-change",
  });
  release.resolve();
  await pending;
  const original = await f.store.getNativeContextOperation(PARENT, ack.operation!.operationId);
  assert.equal(original?.status, "obsolete");
  assert.equal(original?.reason, "policy-changed");
  assert.equal(kernelOf(f.owner.state!).compression.blocks.length, 0);
  await f.replayManual(commandId);
  const usage = await f.store.queryTaskUsage({ sessionID: PARENT });
  const goal = await f.store.readTarget({ sessionID: PARENT });
  assert.deepEqual(
    {
      physicalRequests: f.calls.length,
      taskRequests: usage.modelRequestCount,
      taskTokens: usage.inputTokens + usage.outputTokens,
      goalTokens: goal?.tokensUsed,
    },
    {
      physicalRequests: 1,
      taskRequests: 1,
      taskTokens: getModelUsageTotalTokens(USAGE),
      goalTokens: getModelUsageTotalTokens(USAGE),
    },
  );
  assert.equal((await f.observations())[0]?.actualInputTokens, USAGE.inputTokens);
});
