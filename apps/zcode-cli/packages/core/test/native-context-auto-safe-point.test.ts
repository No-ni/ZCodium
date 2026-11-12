import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType } from "@zcode/contracts";
import type { NativeContextStoredState } from "@zcode/shared/native-context-compression";
import { prepareRuntimeProviderRequest } from "../src/runtime/helpers/runtime-provider-request-messages.js";
import { prepareNativeContext } from "../src/runtime/native-context-compression/index.js";
import { nativeInputBudget } from "../src/runtime/native-context-compression/budgets.js";
import { nativeMaintenanceRanges } from "../src/runtime/native-context-compression/candidates.js";
import { compressNativeContext } from "../src/runtime/native-context-compression/controller.js";
import { protectedNativeIds } from "../src/runtime/native-context-compression/guards.js";
import { nativeRawId } from "../src/runtime/native-context-compression/identity.js";
import {
  nativeCountTokens,
  nativeTextEstimate,
} from "../src/runtime/native-context-compression/measurements.js";
import { projectNativeEntries } from "../src/runtime/native-context-compression/projection.js";
import { kernelOf } from "../src/runtime/native-context-compression/state.js";
import { nativeOutputCandidates } from "../src/runtime/native-context-compression/tool-views.js";
import { PARENT } from "./native-context-boundary-fixture.js";
import { maintenanceFixture, SUMMARY, USAGE } from "./native-context-maintenance-fixture.js";

function configureAutomatic(state: NativeContextStoredState): void {
  state.policy.mode = "auto";
  state.policy.parameters.trigger.start = { kind: "percent", value: 10 };
  state.policy.parameters.trigger.target = { kind: "percent", value: 5 };
  state.policy.parameters.trigger.opportunisticPercent = 5;
  state.policy.parameters.trigger.waitForUsageSample = false;
}

type MaintenanceFixture = Awaited<ReturnType<typeof maintenanceFixture>>;

function currentSendRequest(f: MaintenanceFixture) {
  return prepareRuntimeProviderRequest(f.host, {
    entries: projectNativeEntries(f.safePoint().entries, f.owner.state!),
    model: f.model,
    tools: [],
    registry: f.host.registry,
  }).request;
}

function currentSendEstimate(f: MaintenanceFixture): number {
  const request = currentSendRequest(f);
  return nativeTextEstimate(request.messages, request.tools);
}

function freezeProtectedHistory(f: MaintenanceFixture) {
  const state = f.owner.state!;
  const entries = structuredClone(f.host.messageHistory.borrowReadOnlyRuntimeEntries());
  const request = structuredClone(currentSendRequest(f));
  const budget = nativeInputBudget(f.model);
  assert.ok(budget !== null && budget > 0);
  const estimate = nativeTextEstimate(request.messages, request.tools);
  assert.ok(estimate >= budget * 0.1, "exercise genuine high pressure with a usable model budget");
  const rawIds = new Set(
    entries.map((entry) => {
      const id = nativeRawId(entry);
      assert.ok(id, "each protected entry has a real canonical source");
      return id;
    }),
  );
  assert.equal(rawIds.size, 3);
  assert.deepEqual(protectedNativeIds(entries, state, nativeCountTokens), rawIds);
  assert.deepEqual(nativeMaintenanceRanges(entries, state, budget), []);
  assert.deepEqual(nativeOutputCandidates(entries, state, estimate, budget), []);
  assert.deepEqual(kernelOf(state).compression.blocks, []);
  assert.deepEqual(kernelOf(state).views, {});
  return {
    entries,
    projected: structuredClone(projectNativeEntries(entries, state)),
    request,
    messages: structuredClone(f.messages),
    policy: structuredClone(state.policy),
    historyVersion: state.historyVersion,
  };
}

async function assertProtectedHistoryUnchanged(
  f: MaintenanceFixture,
  before: ReturnType<typeof freezeProtectedHistory>,
) {
  const state = await f.store.getNativeContextState(PARENT);
  assert.ok(state);
  assert.deepEqual(state.policy, before.policy);
  assert.equal(state.historyVersion, before.historyVersion);
  assert.deepEqual(f.host.messageHistory.borrowReadOnlyRuntimeEntries(), before.entries);
  assert.deepEqual(await f.store.messages({ sessionID: PARENT }), before.messages);
  assert.deepEqual(projectNativeEntries(before.entries, state), before.projected);
  assert.deepEqual(currentSendRequest(f), before.request);
  assert.deepEqual(kernelOf(state).compression.blocks, []);
  assert.deepEqual(kernelOf(state).views, {});
  assert.deepEqual(kernelOf(state).projectionOperations?.blocks ?? {}, {});
  assert.deepEqual(kernelOf(state).projectionOperations?.views ?? {}, {});
  assert.deepEqual(state.imageReceipts, []);
  assert.equal(state.requestSeq, 0);
  assert.equal(f.owner.lastObservation, null);
  assert.equal(f.owner.phase, "idle");
  assert.equal(f.host.runtimeCommandQueue.size(), 0);
  assert.equal(f.host.activeForegroundExecution, undefined);
  assert.equal(f.calls.length, 0);
  assert.equal(
    f.published.filter((event) => event.type === SessionEventType.ModelNetworkStatus).length,
    0,
  );
  for (const purpose of ["main", "maintenance", "decision"] as const)
    assert.deepEqual(await f.observations(purpose), []);
  const usage = await f.store.queryTaskUsage({ sessionID: PARENT });
  assert.equal(usage.modelRequestCount, 0);
  assert.equal(usage.modelErrorCount, 0);
  assert.equal(usage.totalTokens, 0);
  assert.equal(usage.inputTokens, 0);
  assert.equal(usage.outputTokens, 0);
}

test("NCTX-05 automatic high-pressure checks pay zero when all canonical history is protected", async (t) => {
  const f = await maintenanceFixture(t, undefined, (state) => {
    configureAutomatic(state);
    state.policy.parameters.history.preserveMessages = 3;
  });
  const before = freezeProtectedHistory(f);
  await assertProtectedHistoryUnchanged(f, before);
  await prepareNativeContext(f.host, f.safePoint());
  const operations = (await f.store.listNativeContextOperations(PARENT, {})).items;
  assert.equal(operations.length, 1);
  assert.equal(operations[0]?.trigger, "automatic");
  assert.equal(operations[0]?.status, "no-benefit");
  assert.equal(operations[0]?.reason, "no-range");
  assert.deepEqual(operations[0]?.observationIds, []);
  const checked = await f.store.getNativeContextState(PARENT);
  assert.ok(checked);
  assert.equal(checked.lastCheckedHistoryVersion, before.historyVersion);

  await prepareNativeContext(f.host, f.safePoint());
  await prepareNativeContext(f.host, f.safePoint());
  assert.deepEqual((await f.store.listNativeContextOperations(PARENT, {})).items, operations);
  assert.equal(
    (await f.store.getNativeContextState(PARENT))?.lastCheckedHistoryVersion,
    checked.lastCheckedHistoryVersion,
  );
  await assertProtectedHistoryUnchanged(f, before);
});

test("NCTX-05 manual high-pressure admission drains and replays without paying for protected history", async (t) => {
  const f = await maintenanceFixture(t, undefined, (state) => {
    configureAutomatic(state);
    state.policy.mode = "manual";
    state.policy.parameters.history.preserveMessages = 3;
  });
  const before = freezeProtectedHistory(f);
  await assertProtectedHistoryUnchanged(f, before);
  const input = {
    commandId: "manual-all-history-protected",
    model: { providerId: f.model.providerId, modelId: f.model.modelId },
    abortSignal: new AbortController().signal,
    traceContext: f.host.rootTraceContext,
  };
  // 只暂停同一 FIFO 的 drain，验证持久 admission；不替代维护模型或跳过候选判断。
  f.host.runtimeCommandDrainActive = true;
  const ack = await compressNativeContext.call(f.host, input);
  assert.equal(ack.operation?.status, "preparing");
  assert.equal(f.host.runtimeCommandQueue.size(), 1);
  assert.equal(f.calls.length, 0);
  assert.equal(
    (await f.store.getNativeContextOperation(PARENT, ack.operation!.operationId))?.status,
    "preparing",
  );
  f.host.runtimeCommandDrainActive = false;
  await f.host.drainRuntimeCommandQueue();
  const operations = (await f.store.listNativeContextOperations(PARENT, {})).items;
  assert.equal(operations.length, 1);
  assert.equal(operations[0]?.operationId, ack.operation?.operationId);
  assert.equal(operations[0]?.trigger, "manual");
  assert.equal(operations[0]?.status, "no-benefit");
  assert.equal(operations[0]?.reason, "no-range");
  assert.deepEqual(operations[0]?.observationIds, []);
  await assertProtectedHistoryUnchanged(f, before);
  const settled = await f.store.getNativeContextState(PARENT);

  await compressNativeContext.call(f.host, input);
  f.owner.commandResults?.clear();
  const recovered = await compressNativeContext.call(f.host, input);
  assert.equal(recovered.operation?.operationId, ack.operation?.operationId);
  assert.equal(recovered.operation?.status, "no-benefit");
  assert.deepEqual((await f.store.listNativeContextOperations(PARENT, {})).items, operations);
  assert.deepEqual(await f.store.getNativeContextState(PARENT), settled);
  await assertProtectedHistoryUnchanged(f, before);
});

test("an automatic safe point runs real maintenance against the model budget and retains the latest canonical user", async (t) => {
  const f = await maintenanceFixture(t, undefined, configureAutomatic);
  const original = structuredClone(f.host.messageHistory.borrowReadOnlyRuntimeEntries());
  const budget = nativeInputBudget(f.model);
  assert.ok(budget !== null && budget > 0);
  const beforeEstimate = currentSendEstimate(f);
  assert.ok(beforeEstimate >= budget * 0.1);
  assert.equal(f.owner.lastObservation, null);

  await prepareNativeContext(f.host, f.safePoint());
  assert.equal(f.calls.length, 1);
  const state = await f.store.getNativeContextState(PARENT);
  assert.ok(state);
  assert.equal(state.policy.mode, "auto");
  assert.equal(state.lastCheckedHistoryVersion, state.historyVersion);
  const active = kernelOf(state).compression.blocks.filter((block) => block.active);
  assert.equal(active.length, 1);
  assert.equal(active[0]?.summary, SUMMARY);
  assert.ok(currentSendEstimate(f) < beforeEstimate);
  assert.deepEqual(f.host.messageHistory.borrowReadOnlyRuntimeEntries(), original);
  const projected = projectNativeEntries(original, state);
  assert.ok(
    projected.some(
      (entry) =>
        entry.kind !== "attachment" &&
        typeof entry.message.content === "string" &&
        entry.message.content.includes("latest-user"),
    ),
  );
  for (const item of f.messages) {
    assert.deepEqual(
      await f.store.messageWithParts({ sessionID: PARENT, messageID: item.info.id }),
      item,
    );
  }

  const operations = (await f.store.listNativeContextOperations(PARENT, { limit: 200 })).items;
  assert.equal(operations.length, 1);
  assert.equal(operations[0]?.trigger, "automatic");
  assert.equal(operations[0]?.status, "completed");
  const rows = await f.observations();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, "completed");
  assert.equal(rows[0]?.actualInputTokens, USAGE.inputTokens);
  assert.equal(rows[0]?.outputTokens, USAGE.outputTokens);
  assert.equal(rows[0]?.cacheReadTokens, 0);
  assert.deepEqual(operations[0]?.observationIds, rows.map((row) => row.id));
  assert.equal((await f.observations("main")).length, 0);
  assert.equal(state.requestSeq, 0);
  assert.equal(f.owner.lastObservation, null);
  assert.equal(f.owner.phase, "idle");

  await prepareNativeContext(f.host, f.safePoint());
  assert.equal(f.calls.length, 1);
  assert.equal((await f.observations()).length, 1);
  const usage = await f.store.queryTaskUsage({ sessionID: PARENT });
  assert.equal(usage.modelRequestCount, 1);
  assert.equal(usage.inputTokens, USAGE.inputTokens);
});

test("a paid automatic check with no benefit is not repeated while the same history remains above the trigger", async (t) => {
  const f = await maintenanceFixture(
    t,
    () => ({ text: '{"ranges":[],"outputs":[]}' }),
    configureAutomatic,
  );
  const budget = nativeInputBudget(f.model);
  assert.ok(budget !== null && budget > 0);
  const beforeEstimate = currentSendEstimate(f);
  assert.ok(beforeEstimate >= budget * 0.1);
  const original = structuredClone(f.host.messageHistory.borrowReadOnlyRuntimeEntries());

  await prepareNativeContext(f.host, f.safePoint());
  const checked = await f.store.getNativeContextState(PARENT);
  assert.ok(checked);
  assert.equal(checked.lastCheckedHistoryVersion, checked.historyVersion);
  assert.equal(kernelOf(checked).compression.blocks.length, 0);
  assert.equal(currentSendEstimate(f), beforeEstimate);
  const first = (await f.store.listNativeContextOperations(PARENT, { limit: 200 })).items;
  assert.equal(first.length, 1);
  assert.equal(first[0]?.status, "no-benefit");
  assert.equal(first[0]?.trigger, "automatic");

  await prepareNativeContext(f.host, f.safePoint());
  await prepareNativeContext(f.host, f.safePoint());
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.host.messageHistory.borrowReadOnlyRuntimeEntries(), original);
  assert.equal(currentSendEstimate(f), beforeEstimate);
  assert.equal((await f.store.listNativeContextOperations(PARENT, { limit: 200 })).items.length, 1);
  assert.equal((await f.observations()).length, 1);
  assert.equal((await f.observations("main")).length, 0);
  assert.equal((await f.store.getNativeContextState(PARENT))?.requestSeq, 0);
  assert.equal(f.owner.phase, "idle");
  const usage = await f.store.queryTaskUsage({ sessionID: PARENT });
  assert.equal(usage.modelRequestCount, 1);
  assert.equal(usage.inputTokens, USAGE.inputTokens);
});
