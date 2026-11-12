import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type ModelUsage } from "@zcode/contracts";
import { recordModelUsageFact } from "../src/runtime/methods/usage-observability.js";
import { nativeGoalUsageCallback } from "../src/runtime/native-context-compression/goal-accounting.js";
import { maintenanceGoalFixture } from "./native-context-maintenance-goal-fixture.js";
import { summaryResult } from "./native-context-maintenance-fixture.js";
import { PARENT } from "./native-context-boundary-fixture.js";

for (const [name, usage, expected] of [
  ["known input with unknown output", { inputTokens: 12 }, 12],
  ["provider total without component estimates", { totalTokens: 15 }, 15],
  ["reported real zero", { inputTokens: 0, outputTokens: 0 }, 0],
] as const) {
  test(
    "the shared normalized callback bills " + name + " exactly once across physical replay",
    async (t) => {
      const f = await maintenanceGoalFixture(t, {
        plan: ({ request }) => ({ text: summaryResult(request.messages), usage }),
      });
      await f.manual("goal-normalized-" + name);
      const callback = nativeGoalUsageCallback(f.runtime, f.goal, f.runtime.rootTraceContext);
      const events = f.events.filter((event) => event.type === SessionEventType.ModelNetworkStatus);
      assert.equal(events.length, 2);
      await recordModelUsageFact(f.runtime, {
        events,
        model: f.model,
        networkEventStartIndex: 0,
        querySource: "native_context_maintenance",
        startedAt: 1,
        status: "completed",
        traceContext: f.runtime.rootTraceContext,
        onModelUsage: callback,
      });
      assert.equal((await f.store.readTarget({ sessionID: PARENT }))?.tokensUsed, expected);
      assert.equal((await f.store.queryTaskUsage({ sessionID: PARENT })).modelRequestCount, 1);
      assert.equal(f.calls.length, 1);
    },
  );
}

test("completely unknown usage creates no zero receipt and later reported input can settle the same physical key", async (t) => {
  const f = await maintenanceGoalFixture(t, {
    plan: ({ request }) => ({ text: summaryResult(request.messages), usage: {} as ModelUsage }),
  });
  await f.manual("goal-unknown-usage");
  assert.equal((await f.store.readTarget({ sessionID: PARENT }))?.tokensUsed, 0);
  const observation = (await f.observations())[0]!;
  assert.equal(observation.actualInputTokens, null);
  assert.equal(observation.outputTokens, null);
  const events = structuredClone(
    f.events.filter((event) => event.type === SessionEventType.ModelNetworkStatus),
  );
  const terminal = events.at(-1)!;
  terminal.payload = {
    ...(terminal.payload as Record<string, unknown>),
    usage: { inputTokens: 7 },
  };
  const input = {
    events,
    model: f.model,
    networkEventStartIndex: 0,
    querySource: "native_context_maintenance",
    startedAt: 1,
    status: "completed" as const,
    traceContext: f.runtime.rootTraceContext,
    onModelUsage: nativeGoalUsageCallback(f.runtime, f.goal, f.runtime.rootTraceContext),
  };
  await recordModelUsageFact(f.runtime, input);
  await recordModelUsageFact(f.runtime, input);
  assert.equal((await f.store.readTarget({ sessionID: PARENT }))?.tokensUsed, 7);
  assert.equal((await f.store.queryTaskUsage({ sessionID: PARENT })).modelRequestCount, 1);
  assert.equal(f.calls.length, 1);
});
