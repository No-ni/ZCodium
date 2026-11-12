import assert from "node:assert/strict";
import test from "node:test";
import { prepareNativeContext } from "../src/runtime/native-context-compression/safe-point.js";
import { runNativeMaintenance } from "../src/runtime/native-context-compression/maintenance.js";
import {
  buildNativeContextForkBundle,
  recoverNativeContext,
  rebaseNativeContext,
  resetNativeContextAfterCompact,
} from "../src/runtime/native-context-compression/boundaries.js";
import { nativeForkRecordId } from "../src/runtime/native-context-compression/boundary-records.js";
import {
  kernelOf,
  nativeOwner,
  writeNativeState,
} from "../src/runtime/native-context-compression/state.js";
import { projectNativeEntries } from "../src/runtime/native-context-compression/projection.js";
import { block, compactMessage, PARENT, rewind } from "./native-context-boundary-fixture.js";
import { maintenanceFixture, SUMMARY, USAGE } from "./native-context-maintenance-fixture.js";
import {
  completeMain,
  configureAutomatic,
  forkMaps,
  projection,
  seededProjection,
} from "./native-context-projection-provenance-fixture.js";

test("second and third real main observations still reference the automatically committed summary without repeating maintenance costs", async (t) => {
  const f = await maintenanceFixture(t, undefined, configureAutomatic);
  await prepareNativeContext(f.host, f.safePoint());
  const operation = (await f.store.listNativeContextOperations(PARENT, { limit: 200 })).items[0]!;
  assert.equal(operation.status, "completed");
  const original = structuredClone(f.safePoint().entries);
  const first = await completeMain(f, "provenance-first");
  assert.deepEqual(first.rows[0]!.operationIds, [operation.operationId]);
  assert.deepEqual(f.owner.pendingOperationIds, []);
  for (const requestId of ["provenance-second", "provenance-third"]) {
    const next = await completeMain(f, requestId);
    assert.ok(JSON.stringify(next.request.messages).includes(SUMMARY));
    assert.deepEqual(next.rows[0]!.operationIds, [operation.operationId]);
    assert.equal(next.rows[0]!.actualInputTokens, 50);
    const rawUsage = next.facts[0]!.rawUsage;
    assert.ok(rawUsage && typeof rawUsage === "object" && "inputTokens" in rawUsage);
    assert.equal(rawUsage.inputTokens, 50);
    assert.equal(next.facts[0]!.id, next.rows[0]!.usageRecordRef);
  }
  assert.deepEqual(f.safePoint().entries, original);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.observations()).length, 1);
  const usage = await f.store.queryTaskUsage({ sessionID: PARENT });
  assert.equal(usage.modelRequestCount, 4);
  // 既有任务总览按相邻主输入增量计量；逐请求事实在上面的 rawUsage/观察里核对。
  assert.equal(usage.inputTokens, USAGE.inputTokens! + 50);
  assert.equal((await f.observations("main")).length, 3);
});

test("a cold Runtime reuses persisted production relationships without pending or another paid call", async (t) => {
  const f = await maintenanceFixture(t, undefined, configureAutomatic);
  await prepareNativeContext(f.host, f.safePoint());
  const id = f.owner.lastOperation!.operationId;
  await completeMain(f, "provenance-before-resume");
  const cold = { ...f.host };
  await recoverNativeContext(cold);
  const resumed = { ...f, host: cold, owner: nativeOwner(cold) };
  assert.deepEqual(resumed.owner.pendingOperationIds, []);
  assert.deepEqual(projection(resumed).comparison!.operationIds, [id]);
  assert.equal(f.calls.length, 1);
});

test("only the summary actually inserted into this request is linked, even when more active blocks are stored", async (t) => {
  const f = await seededProjection(t);
  const result = projection(f, f.safePoint().entries.slice(0, 2));
  assert.ok(JSON.stringify(result.entries).includes("合成块 kept"));
  assert.equal(JSON.stringify(result.entries).includes("合成块 future"), false);
  assert.deepEqual(result.comparison!.operationIds, [f.producer.operationId]);
});

for (const tier of [2, 3] as const)
  test(`a tier ${tier} replacement links its current producer rather than superseded blocks or hidden views`, async (t) => {
    const f = await seededProjection(t);
    await writeNativeState(f.owner, (next) => {
      const kernel = kernelOf(next);
      const old = kernel.compression.blocks[0]!;
      old.active = false;
      const current = block("replacement", [f.first.rawId], [old.blockId]);
      current.tier = tier;
      kernel.compression.blocks = [old, current];
      kernel.projectionOperations!.blocks.replacement = f.discarded.operationId;
    });
    const result = projection(f, f.safePoint().entries.slice(0, 2));
    assert.ok(JSON.stringify(result.entries).includes("合成块 replacement"));
    assert.equal(JSON.stringify(result.entries).includes("kept view"), false);
    assert.deepEqual(result.comparison!.operationIds, [f.discarded.operationId]);
  });

test("only a view that changes the outgoing content contributes a production relationship", async (t) => {
  const f = await seededProjection(t);
  await writeNativeState(f.owner, (next) => {
    const kernel = kernelOf(next);
    kernel.compression.blocks = [];
    const original = f.safePoint().entries[2]!;
    assert.ok(original.kind !== "attachment");
    kernel.views[f.future.rawId]!.text = String(original.message.content);
  });
  const result = projection(f);
  assert.ok(JSON.stringify(result.entries).includes("kept view"));
  assert.deepEqual(result.comparison!.operationIds, [f.producer.operationId]);
});

test("legacy state without production relationships does not guess an association from stored blocks or history", async (t) => {
  const f = await seededProjection(t);
  await writeNativeState(f.owner, (next) => {
    delete kernelOf(next).projectionOperations;
  });
  assert.ok(JSON.stringify(projection(f).entries).includes("合成块 kept"));
  assert.deepEqual(projection(f).comparison!.operationIds, []);
});

test("a rejected final summary CAS leaves neither completed production relationships nor a new block", async (t) => {
  const f = await maintenanceFixture(t);
  const commit = f.store.commitNativeContext.bind(f.store);
  f.store.commitNativeContext = async (sessionId, input) => {
    if (input.operations?.some((operation) => operation.status === "completed"))
      throw new Error("synthetic final candidate rejection");
    await commit(sessionId, input);
  };
  const result = await runNativeMaintenance(f.host, f.safePoint(), "manual");
  assert.equal(result.operation?.status, "error");
  const state = await f.store.getNativeContextState(PARENT);
  assert.ok(state);
  assert.equal(kernelOf(state).compression.blocks.length, 0);
  assert.equal(kernelOf(state).projectionOperations, undefined);
  assert.deepEqual(projection(f).comparison!.operationIds, []);
  assert.equal((await f.observations())[0]!.actualInputTokens, USAGE.inputTokens);
});

test("rewind removes future relationships while preserving exact kept production IDs", async (t) => {
  const f = await seededProjection(t);
  await rewind(f.host, f.messages, 2);
  await rebaseNativeContext(f.host);
  const state = await f.store.getNativeContextState(PARENT);
  assert.ok(state);
  assert.deepEqual(kernelOf(state).projectionOperations, {
    blocks: { kept: f.producer.operationId },
    views: { [f.first.rawId]: f.producer.operationId },
  });
  assert.deepEqual(projection(f).comparison!.operationIds, [f.producer.operationId]);
});

test("fork keeps only prefix relationships and remaps producer IDs with the inherited records", async (t) => {
  const f = await seededProjection(t);
  const maps = forkMaps(f, 2);
  const bundle = await buildNativeContextForkBundle(
    f.host,
    maps,
    f.messages.slice(0, 2).map((item) => String(item.info.id)),
  );
  assert.ok(bundle);
  const inherited = nativeForkRecordId(maps, "operation", f.producer.operationId);
  const childRaw = `${maps.messageIds.get(f.first.messageId)}#e0`;
  assert.deepEqual(kernelOf(bundle.state).projectionOperations, {
    blocks: { kept: inherited },
    views: { [childRaw]: inherited },
  });
  assert.deepEqual(
    bundle.operations.map((operation) => operation.operationId),
    [inherited],
  );
  assert.equal(bundle.operations[0]!.origin, "inherited");
  const children = f
    .safePoint()
    .entries.slice(0, 2)
    .map((entry) => ({
      ...entry,
      canonical: {
        ...entry.canonical!,
        messageId: maps.messageIds.get(entry.canonical!.messageId)!,
      },
    }));
  assert.ok(JSON.stringify(projectNativeEntries(children, bundle.state)).includes("合成块 kept"));
  assert.deepEqual(kernelOf(f.owner.state!).projectionOperations!.blocks, {
    kept: f.producer.operationId,
    future: f.discarded.operationId,
  });
});

test("a persisted compact boundary clears sending relationships but preserves historical operations and costs", async (t) => {
  const f = await maintenanceFixture(t);
  const completed = await runNativeMaintenance(f.host, f.safePoint(), "manual");
  assert.equal(completed.operation?.status, "completed");
  const before = await f.observations();
  const summary = compactMessage();
  await f.store.commitMessageBundle({ sessionID: PARENT, messages: [summary] });
  await resetNativeContextAfterCompact(f.host, "compact-boundary");
  const bundle = await f.store.getNativeContextForkBundle(PARENT);
  assert.ok(bundle);
  assert.deepEqual(kernelOf(bundle.state).projectionOperations, { blocks: {}, views: {} });
  assert.ok(
    bundle.operations.some(
      (operation) => operation.operationId === completed.operation!.operationId,
    ),
  );
  assert.deepEqual(bundle.observations, before);
  const usage = await f.store.queryTaskUsage({ sessionID: PARENT });
  assert.equal(usage.modelRequestCount, 1);
  assert.equal(usage.inputTokens, USAGE.inputTokens);
  assert.equal(bundle.state.generation, 0);
});
