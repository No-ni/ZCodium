import assert from "node:assert/strict";
import test from "node:test";
import { getModelUsageTotalTokens } from "@zcode/contracts";
import { prepareNativeContext } from "../src/runtime/native-context-compression/index.js";
import { compressNativeContext } from "../src/runtime/native-context-compression/controller.js";
import { kernelOf } from "../src/runtime/native-context-compression/state.js";
import { PARENT } from "./native-context-boundary-fixture.js";
import { deferred, summaryResult, USAGE } from "./native-context-maintenance-fixture.js";
import { maintenanceGoalFixture } from "./native-context-maintenance-goal-fixture.js";

test("a skipped paused safe point does not consume the same history when the existing Goal resumes", async (t) => {
  const f = await maintenanceGoalFixture(t, { automatic: true, status: "paused" });
  await prepareNativeContext(f.runtime, f.safePoint());
  assert.notEqual(f.owner.state!.lastCheckedHistoryVersion, f.owner.state!.historyVersion);
  await f.store.updateTargetStatus({ sessionID: PARENT, status: "active" });
  await prepareNativeContext(f.runtime, f.safePoint());
  assert.equal(f.calls.length, 1);
  assert.equal(
    (await f.store.readTarget({ sessionID: PARENT }))?.tokensUsed,
    getModelUsageTotalTokens(USAGE),
  );
  await prepareNativeContext(f.runtime, f.safePoint());
  assert.equal(f.calls.length, 1);
});

test("an admitted FIFO maintenance rechecks Goal pause before starting a payable request", async (t) => {
  const f = await maintenanceGoalFixture(t);
  f.runtime.runtimeCommandDrainActive = true;
  const ack = await compressNativeContext.call(f.runtime, f.input("goal-pause-after-admission"));
  assert.equal(ack.operation?.status, "preparing");
  await f.store.updateTargetStatus({ sessionID: PARENT, status: "paused" });
  f.runtime.runtimeCommandDrainActive = false;
  await f.runtime.drainRuntimeCommandQueue();
  assert.equal(f.calls.length, 0);
  assert.equal((await f.store.queryTaskUsage({ sessionID: PARENT })).modelRequestCount, 0);
  assert.equal((await f.store.readTarget({ sessionID: PARENT }))?.status, "paused");
  assert.equal((await f.store.readTarget({ sessionID: PARENT }))?.tokensUsed, 0);
  assert.equal(f.owner.phase, "idle");
  assert.equal(f.runtime.runtimeCommandQueue.size(), 0);
});

test("a real paid decision that exhausts the Goal budget prevents the following summary request", async (t) => {
  const f = await maintenanceGoalFixture(t, {
    automatic: true,
    tokenBudget: 12,
    decisionPlan: () => ({
      text: '{"compress":true}',
      usage: { inputTokens: 12, outputTokens: 0 },
    }),
    configure: (state) => {
      state.policy.parameters.trigger.start = { kind: "percent", value: 90 };
      state.policy.parameters.trigger.modelDecides = true;
      state.policy.parameters.trigger.periodicCheckRounds = 1;
      state.roundsSinceMaintenance = 1;
    },
  });
  await prepareNativeContext(f.runtime, f.safePoint());
  assert.deepEqual(
    f.invocations.map((call) => call.querySource),
    ["native_context_decision"],
  );
  const goal = await f.store.readTarget({ sessionID: PARENT });
  assert.equal(goal?.tokensUsed, 12);
  assert.equal(goal?.status, "budget_limited");
  assert.equal((await f.observations("decision")).length, 1);
  assert.equal((await f.observations()).length, 0);
  assert.equal((await f.store.queryTaskUsage({ sessionID: PARENT })).modelRequestCount, 1);
  assert.equal(kernelOf(f.owner.state!).compression.blocks.length, 0);
});

for (const change of ["clear", "replace"] as const) {
  test(
    "a started maintenance cannot transfer its frozen Goal charge after " + change,
    async (t) => {
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
      f.runtime.runtimeCommandDrainActive = true;
      await compressNativeContext.call(f.runtime, f.input("goal-owner-change-" + change));
      f.runtime.runtimeCommandDrainActive = false;
      const pending = f.runtime.drainRuntimeCommandQueue();
      assert.equal(
        await Promise.race([started.promise.then(() => true), pending.then(() => false)]),
        true,
      );
      await f.store.clearTarget({ sessionID: PARENT });
      if (change === "replace") {
        const replacement = await f.store.setTarget({
          sessionID: PARENT,
          objective: "Synthetic replacement Goal.",
        });
        assert.notEqual(replacement.targetID, f.goal.targetID);
      }
      release.resolve();
      await pending;
      const goal = await f.store.readTarget({ sessionID: PARENT });
      assert.equal(goal?.tokensUsed ?? 0, 0);
      assert.equal(goal === null, change === "clear");
      const usage = await f.store.queryTaskUsage({ sessionID: PARENT });
      assert.equal(usage.inputTokens + usage.outputTokens, getModelUsageTotalTokens(USAGE));
      assert.equal(f.calls.length, 1);
    },
  );
}

test("a generic model ledger write failure still delivers paid maintenance to the Goal owner", async (t) => {
  const f = await maintenanceGoalFixture(t);
  f.store.recordModelUsage = async () => {
    throw new Error("Synthetic ledger write failure.");
  };
  await f.manual("goal-independent-ledger-failure");
  assert.equal(f.calls.length, 1);
  assert.equal((await f.store.queryTaskUsage({ sessionID: PARENT })).modelRequestCount, 0);
  assert.equal(
    (await f.store.readTarget({ sessionID: PARENT }))?.tokensUsed,
    getModelUsageTotalTokens(USAGE),
  );
  assert.equal(kernelOf(f.owner.state!).compression.blocks.length, 1);
});

test("a final summary candidate commit failure preserves both model and Goal costs", async (t) => {
  const f = await maintenanceGoalFixture(t);
  const commit = f.store.commitNativeContext.bind(f.store);
  let failed = false;
  f.store.commitNativeContext = async (sessionID, input) => {
    if (
      !failed &&
      input.operations?.some(
        (operation) => operation.kind === "summary" && operation.status === "completed",
      )
    ) {
      failed = true;
      throw new Error("Synthetic candidate transaction fault.");
    }
    await commit(sessionID, input);
  };
  const ack = await f.manual("goal-candidate-commit-failure");
  assert.equal(failed, true);
  assert.equal(
    (await f.store.getNativeContextOperation(PARENT, ack.operation!.operationId))?.status,
    "error",
  );
  assert.equal(kernelOf(f.owner.state!).compression.blocks.length, 0);
  assert.equal(
    (await f.store.readTarget({ sessionID: PARENT }))?.tokensUsed,
    getModelUsageTotalTokens(USAGE),
  );
  const usage = await f.store.queryTaskUsage({ sessionID: PARENT });
  assert.equal(usage.inputTokens + usage.outputTokens, getModelUsageTotalTokens(USAGE));
  assert.equal(f.owner.phase, "idle");
});

test("an unreadable Goal is not treated as absent when an automatic payable safe point is evaluated", async (t) => {
  const f = await maintenanceGoalFixture(t, { automatic: true });
  f.store.readTarget = async () => {
    throw new Error("Synthetic Goal read failure.");
  };
  await assert.rejects(prepareNativeContext(f.runtime, f.safePoint()));
  assert.equal(f.calls.length, 0);
  assert.equal((await f.store.queryTaskUsage({ sessionID: PARENT })).modelRequestCount, 0);
  assert.notEqual(f.owner.state!.lastCheckedHistoryVersion, f.owner.state!.historyVersion);
  assert.equal(f.owner.phase, "idle");
});

test("pausing after the real request starts retains its paid cost without reopening the Goal", async (t) => {
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
  f.runtime.runtimeCommandDrainActive = true;
  await compressNativeContext.call(f.runtime, f.input("goal-pause-after-start"));
  f.runtime.runtimeCommandDrainActive = false;
  const pending = f.runtime.drainRuntimeCommandQueue();
  assert.equal(
    await Promise.race([started.promise.then(() => true), pending.then(() => false)]),
    true,
  );
  await f.store.updateTargetStatus({ sessionID: PARENT, status: "paused" });
  release.resolve();
  await pending;
  const goal = await f.store.readTarget({ sessionID: PARENT });
  assert.equal(goal?.status, "paused");
  assert.equal(goal?.tokensUsed, getModelUsageTotalTokens(USAGE));
  await f.replayManual("goal-pause-after-start");
  assert.equal(f.calls.length, 1);
  assert.equal(
    (await f.store.readTarget({ sessionID: PARENT }))?.tokensUsed,
    getModelUsageTotalTokens(USAGE),
  );
});

test("a Goal accounting failure is isolated from a successful native summary and the real model ledger", async (t) => {
  const f = await maintenanceGoalFixture(t);
  f.store.accountTargetUsage = async () => {
    throw new Error("Synthetic Goal transaction failure.");
  };
  const ack = await f.manual("goal-account-write-failure");
  assert.equal(
    (await f.store.getNativeContextOperation(PARENT, ack.operation!.operationId))?.status,
    "completed",
  );
  assert.equal((await f.store.readTarget({ sessionID: PARENT }))?.tokensUsed, 0);
  const usage = await f.store.queryTaskUsage({ sessionID: PARENT });
  assert.equal(usage.inputTokens + usage.outputTokens, getModelUsageTotalTokens(USAGE));
  assert.equal(kernelOf(f.owner.state!).compression.blocks.length, 1);
});
