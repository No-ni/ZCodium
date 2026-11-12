import assert from "node:assert/strict";
import test from "node:test";
import { runNativeMaintenance } from "../src/runtime/native-context-compression/maintenance.js";
import { setNativeContextPolicy } from "../src/runtime/native-context-compression/controller.js";
import { kernelOf } from "../src/runtime/native-context-compression/state.js";
import { projectNativeEntries } from "../src/runtime/native-context-compression/projection.js";
import {
  chargedFailure,
  deferred,
  maintenanceFixture,
  SUMMARY,
  summaryResult,
  USAGE,
} from "./native-context-maintenance-fixture.js";
import { PARENT } from "./native-context-boundary-fixture.js";

test("complete native maintenance commits a recoverable summary and its actual cost without inventing a main request", async (t) => {
  const f = await maintenanceFixture(t);
  const original = structuredClone(f.host.messageHistory.borrowReadOnlyRuntimeEntries());
  const result = await runNativeMaintenance(f.host, f.safePoint(), "manual");
  assert.equal(result.operation?.status, "completed");
  assert.equal(f.calls.length, 1);
  const state = await f.store.getNativeContextState(PARENT);
  assert.ok(state);
  assert.equal(kernelOf(state).compression.blocks.filter((block) => block.active).length, 1);
  assert.deepEqual(f.host.messageHistory.borrowReadOnlyRuntimeEntries(), original);
  const projected = projectNativeEntries(original, state);
  assert.ok(
    projected.some(
      (entry) =>
        entry.kind !== "attachment" &&
        typeof entry.message.content === "string" &&
        entry.message.content.includes(SUMMARY),
    ),
  );
  assert.ok(
    projected.some(
      (entry) =>
        entry.kind !== "attachment" &&
        typeof entry.message.content === "string" &&
        entry.message.content.includes("latest-user"),
    ),
  );
  assert.ok(state.sources.every((source) => source.originalAvailable));
  const rows = await f.observations();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.actualInputTokens, USAGE.inputTokens);
  assert.equal(rows[0]?.cacheReadTokens, 0);
  assert.deepEqual(result.operation?.observationIds, rows.map((row) => row.id));
  assert.equal((await f.observations("main")).length, 0);
  assert.equal(state.requestSeq, 0);
  assert.equal(f.owner.lastObservation, null);
  assert.equal(f.owner.phase, "idle");
  const usage = await f.store.queryTaskUsage({ sessionID: PARENT });
  assert.equal(usage.modelRequestCount, 1);
  assert.equal(usage.inputTokens, USAGE.inputTokens);
});

test("invalid, incomplete and no-benefit model responses preserve their reported maintenance cost and leave the send view intact", async (t) => {
  const cases = [
    {
      name: "malformed JSON",
      response: { text: "synthetic invalid JSON" },
      reason: "invalid-summary",
    },
    {
      name: "unknown range",
      response: {
        text: JSON.stringify({
          ranges: [{ startRef: "unknown", endRef: "unknown", summary: SUMMARY }],
          outputs: [],
        }),
      },
      reason: "invalid-summary",
    },
    {
      name: "no offered compression",
      response: { text: '{"ranges":[],"outputs":[]}' },
      reason: "no-benefit",
    },
    {
      name: "output budget exhausted",
      response: { text: '{"ranges":[],"outputs":[]}', finishReason: "length" },
      reason: "invalid-summary",
    },
  ];
  for (const scenario of cases)
    await t.test(scenario.name, async (subtest) => {
      const f = await maintenanceFixture(subtest, () => scenario.response);
      const originalKernel = structuredClone(kernelOf(f.owner.state!));
      const result = await runNativeMaintenance(f.host, f.safePoint(), "manual");
      assert.equal(result.operation?.status, "no-benefit");
      assert.equal(result.operation?.reason, scenario.reason);
      assert.deepEqual(kernelOf(f.owner.state!), originalKernel);
      assert.equal(f.owner.phase, "idle");
      assert.equal((await f.observations("main")).length, 0);
      const row = (await f.observations())[0]!;
      assert.equal(row.status, "completed");
      assert.equal(row.actualInputTokens, USAGE.inputTokens);
      assert.ok(result.operation?.observationIds.includes(row.id));
      assert.equal(
        (await f.store.queryTaskUsage({ sessionID: PARENT })).inputTokens,
        USAGE.inputTokens,
      );
    });
});

test("a range reduction whose reference overhead increases the full request is rejected without losing the paid model cost", async (t) => {
  let summary = "";
  const f = await maintenanceFixture(
    t,
    ({ request }) => ({ text: summaryResult(request.messages, summary) }),
    (state) => {
      state.policy.parameters.summary.minReductionPercent = 0;
    },
  );
  summary = f.host.messageHistory
    .borrowReadOnlyRuntimeEntries()
    .slice(0, 2)
    .map((entry) => (entry.kind === "attachment" ? entry.content : entry.message.content))
    .join("\n")
    .slice(0, -32);
  const originalKernel = structuredClone(kernelOf(f.owner.state!));
  const result = await runNativeMaintenance(f.host, f.safePoint(), "manual");
  assert.equal(f.calls.length, 1);
  assert.equal(result.operation?.status, "no-benefit");
  assert.equal(result.operation?.reason, "no-benefit");
  assert.deepEqual(kernelOf(f.owner.state!), originalKernel);
  assert.equal((await f.observations())[0]?.actualInputTokens, USAGE.inputTokens);
  assert.equal(
    (await f.store.queryTaskUsage({ sessionID: PARENT })).inputTokens,
    USAGE.inputTokens,
  );
});

test("a cancelled started maintenance request keeps charged failure usage and releases the shared phase", async (t) => {
  const started = deferred();
  const f = await maintenanceFixture(t, async ({ request }) => {
    started.resolve();
    await new Promise<void>((resolve) => {
      if (request.abortSignal?.aborted) resolve();
      else request.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
    });
    throw chargedFailure({ inputTokens: 12, outputTokens: 0, cacheReadTokens: 0 });
  });
  const abort = new AbortController();
  const pending = runNativeMaintenance(
    f.host,
    { ...f.safePoint(), signal: abort.signal },
    "manual",
  );
  await started.promise;
  abort.abort(new Error("synthetic user stop"));
  const result = await pending;
  assert.equal(result.operation?.status, "cancelled");
  assert.equal(result.operation?.reason, "cancelled");
  assert.equal(kernelOf(f.owner.state!).compression.blocks.length, 0);
  assert.equal(f.owner.phase, "idle");
  const row = (await f.observations())[0]!;
  assert.equal(row.status, "cancelled");
  assert.equal(row.actualInputTokens, 12);
  assert.equal(row.outputTokens, 0);
  assert.equal((await f.store.queryTaskUsage({ sessionID: PARENT })).inputTokens, 12);
});

test("pre-start cancellation creates an operation but no imaginary model cost or trend point", async (t) => {
  const f = await maintenanceFixture(t);
  const abort = new AbortController();
  abort.abort(new Error("synthetic pre-start cancellation"));
  const result = await runNativeMaintenance(
    f.host,
    { ...f.safePoint(), signal: abort.signal },
    "manual",
  );
  assert.equal(result.operation?.status, "cancelled");
  assert.equal(f.calls.length, 0);
  assert.equal((await f.observations()).length, 0);
  assert.equal((await f.store.queryTaskUsage({ sessionID: PARENT })).modelRequestCount, 0);
  assert.equal(f.owner.phase, "idle");
});

test("a policy or canonical history change invalidates a late summary while retaining its real provider cost", async (t) => {
  for (const change of ["policy", "history"] as const)
    await t.test(change, async (subtest) => {
      const started = deferred(),
        release = deferred();
      const f = await maintenanceFixture(subtest, async ({ request }) => {
        started.resolve();
        await release.promise;
        return { text: summaryResult(request.messages) };
      });
      const pending = runNativeMaintenance(f.host, f.safePoint(), "manual");
      await started.promise;
      if (change === "policy") {
        const { policyVersion, ...configuration } = structuredClone(f.owner.state!.policy);
        configuration.parameters.summary.minReductionPercent += 1;
        await setNativeContextPolicy.call(f.host, {
          configuration,
          expectedPolicyVersion: policyVersion,
          commandId: "fixture-policy-change",
        });
      } else await f.appendHistory();
      release.resolve();
      const result = await pending;
      assert.equal(result.operation?.status, "obsolete");
      assert.equal(
        result.operation?.reason,
        change === "policy" ? "policy-changed" : "history-changed",
      );
      assert.equal(kernelOf(f.owner.state!).compression.blocks.length, 0);
      assert.equal(f.owner.phase, "idle");
      const rows = await f.observations();
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.actualInputTokens, USAGE.inputTokens);
      assert.equal(rows[0]?.policyVersion, 3);
      assert.equal(rows[0]?.historyVersion, f.state.historyVersion);
      assert.ok(result.operation?.observationIds.includes(rows[0]!.id));
      assert.equal(
        (await f.store.queryTaskUsage({ sessionID: PARENT })).inputTokens,
        USAGE.inputTokens,
      );
    });
});
