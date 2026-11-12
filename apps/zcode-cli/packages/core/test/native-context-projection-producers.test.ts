import assert from "node:assert/strict";
import test from "node:test";
import type { NativeContextStoredState } from "@zcode/shared/native-context-compression";
import type { ToolEntry, ToolExecutionContext } from "../src/tool/types.js";
import { prepareNativeContext } from "../src/runtime/native-context-compression/safe-point.js";
import { registerNativeContextTools } from "../src/runtime/native-context-compression/tools.js";
import { nativeMaintenanceRanges } from "../src/runtime/native-context-compression/candidates.js";
import { kernelOf } from "../src/runtime/native-context-compression/state.js";
import { projectNativeEntries } from "../src/runtime/native-context-compression/projection.js";
import { NativeContextRuntimeError } from "../src/runtime/native-context-compression/contract.js";
import { nativeRawId } from "../src/runtime/native-context-compression/identity.js";
import { PARENT } from "./native-context-boundary-fixture.js";
import { maintenanceFixture, SUMMARY } from "./native-context-maintenance-fixture.js";
import {
  appendProjectionTool,
  completeMain,
  projection,
  seededProjection,
} from "./native-context-projection-provenance-fixture.js";

function referencePolicy(state: NativeContextStoredState, simplify: boolean): void {
  state.policy.mode = "auto";
  const parameters = state.policy.parameters;
  parameters.trigger.start = { kind: "percent", value: 90 };
  parameters.trigger.target = { kind: "percent", value: 85 };
  parameters.trigger.opportunisticPercent = 85;
  parameters.trigger.periodicCheckRounds = 0;
  parameters.history.protectedTools = [];
  parameters.history.protectedLatestTools = [];
  // 简化按共享契约要求启用 distill；本例是无图 JSON 且未达压力，因此不会启动付费提炼。
  parameters.tools.distill.enabled = simplify;
  parameters.tools.distill.mediaOnly = true;
  parameters.tools.distill.minContextPercent = 90;
  parameters.tools.reference.enabled = true;
  parameters.tools.reference.excludeTools = [];
  parameters.tools.reference.minTokens = 1;
  parameters.tools.reference.headChars = 10;
  parameters.tools.simplify.enabled = simplify;
  parameters.tools.simplify.minReductionPercent = 1;
  for (const [name, strategy] of Object.entries(parameters.tools.simplify.strategies)) {
    strategy.enabled = name === "json-fold";
    strategy.excludeTools = [];
  }
}

for (const simplify of [false, true])
  test(`a live ${simplify ? "simplified" : "referenced"} completed ToolPart binds its producer in the same persisted transformation`, async (t) => {
    const f = await maintenanceFixture(t, undefined, (state) => referencePolicy(state, simplify));
    const text = JSON.stringify({
      items: Array.from({ length: 150 }, (_, index) => ({
        index,
        content: "synthetic retained original ".repeat(5),
      })),
    });
    const tool = await appendProjectionTool(f, text);
    const before = structuredClone(f.messages);
    await prepareNativeContext(f.host, f.safePoint());
    const entry = f
      .safePoint()
      .entries.find(
        (item) =>
          item.kind !== "attachment" &&
          item.canonical?.partId === tool.id &&
          item.message.role === "tool",
      )!;
    assert.ok(entry);
    const rawId = nativeRawId(entry)!;
    const state = (await f.store.getNativeContextState(PARENT))!;
    const operations = (await f.store.listNativeContextOperations(PARENT, { limit: 200 })).items;
    assert.equal(operations.length, 1);
    assert.equal(operations[0]!.kind, "reference");
    assert.equal(operations[0]!.status, "completed");
    assert.equal(kernelOf(state).views[rawId]!.kind, simplify ? "simplified" : "reference");
    assert.equal(kernelOf(state).projectionOperations!.views[rawId], operations[0]!.operationId);
    assert.deepEqual(f.owner.pendingOperationIds, []);
    for (const requestId of ["view-first", "view-next"]) {
      const main = await completeMain(f, requestId);
      assert.deepEqual(main.prepared.comparison!.operationIds, [operations[0]!.operationId]);
      assert.ok(JSON.stringify(main.request.messages).includes("context_read"));
      assert.equal(JSON.stringify(main.request.messages).includes(text), false);
    }
    await prepareNativeContext(f.host, f.safePoint());
    assert.equal(
      (await f.store.listNativeContextOperations(PARENT, { limit: 200 })).items.length,
      1,
    );
    assert.deepEqual(f.messages, before);
    assert.equal(f.calls.length, 0);
  });

test("the registered context_compress tool commits its exact block producer once and links subsequent actual projections", async (t) => {
  const f = await maintenanceFixture(t);
  const tools = new Map<string, ToolEntry>();
  f.host.registry = {
    register: (entry: ToolEntry) => tools.set(entry.metadata.name, entry),
    get: (name: string) => tools.get(name),
    list: () => [...tools.values()],
  } as unknown as typeof f.host.registry;
  registerNativeContextTools(f.host);
  const entry = tools.get("context_compress");
  assert.ok(entry);
  const ranges = nativeMaintenanceRanges(f.safePoint().entries, f.owner.state!, 32768);
  assert.ok(ranges[0]);
  const context: ToolExecutionContext = {
    toolCallId: "projection-compress-call",
    traceId: f.host.rootTraceContext.traceId,
    abortSignal: new AbortController().signal,
    model: f.model,
    sessionId: PARENT,
    workingDirectory: "fixture-workspace",
    workspaceRoot: "fixture-workspace",
    workspaceScopeRoot: "fixture-workspace",
  };
  await entry.handler(
    { ranges: [{ startRef: ranges[0].startRef, endRef: ranges[0].endRef, summary: SUMMARY }] },
    context,
  );
  const operation = (await f.store.listNativeContextOperations(PARENT, { limit: 200 })).items[0]!;
  assert.equal(operation.trigger, "model");
  assert.equal(operation.status, "completed");
  const state = (await f.store.getNativeContextState(PARENT))!;
  assert.deepEqual(Object.values(kernelOf(state).projectionOperations!.blocks), [
    operation.operationId,
  ]);
  assert.deepEqual(f.owner.pendingOperationIds, []);
  for (const requestId of ["model-compress-first", "model-compress-next"]) {
    const result = await completeMain(f, requestId);
    assert.ok(JSON.stringify(result.request.messages).includes(SUMMARY));
    assert.deepEqual(result.prepared.comparison!.operationIds, [operation.operationId]);
  }
  assert.equal(f.calls.length, 0);
});

test("one-shot pending links are consumed once while active producers remain, with a deduplicated bound of 100 IDs", async (t) => {
  const f = await seededProjection(t);
  const entries = f.safePoint().entries.slice(0, 2);
  f.owner.pendingOperationIds = [
    f.discarded.operationId,
    f.discarded.operationId,
    f.producer.operationId,
  ];
  const first = await completeMain(f, "pending-first", entries);
  assert.deepEqual(first.prepared.comparison!.operationIds, [
    f.producer.operationId,
    f.discarded.operationId,
  ]);
  assert.deepEqual(f.owner.pendingOperationIds, []);
  const second = await completeMain(f, "pending-next", entries);
  assert.deepEqual(second.prepared.comparison!.operationIds, [f.producer.operationId]);
  f.owner.pendingOperationIds = Array.from(
    { length: 105 },
    (_, index) => "bounded-pending-" + index,
  );
  const bounded = projection(f, entries).comparison!.operationIds;
  assert.equal(bounded.length, 100);
  assert.equal(new Set(bounded).size, 100);
  assert.deepEqual(bounded, f.owner.pendingOperationIds.slice(-100));
});

test("absent legacy production data stays unknown but malformed persisted relationships fail closed", async (t) => {
  const f = await seededProjection(t);
  for (const malformed of [null, false, { blocks: { kept: 27 }, views: {} }]) {
    const state = structuredClone(f.owner.state!);
    state.kernel.projectionOperations = malformed;
    assert.throws(
      () => projectNativeEntries(f.safePoint().entries, state),
      (error: unknown) =>
        error instanceof NativeContextRuntimeError && error.code === "invalid-state",
    );
  }
});
