import assert from "node:assert/strict";
import test from "node:test";
import { getModelUsageTotalTokens, type ModelSelection } from "@zcode/contracts";
import { compressNativeContext } from "../src/runtime/native-context-compression/controller.js";
import { NativeContextRuntimeError } from "../src/runtime/native-context-compression/contract.js";
import { prepareNativeContext } from "../src/runtime/native-context-compression/index.js";
import { kernelOf, writeNativeState } from "../src/runtime/native-context-compression/state.js";
import { modelFreezeFixture } from "./native-context-model-freeze-fixture.js";
import { deferred, USAGE } from "./native-context-maintenance-fixture.js";
import { PARENT } from "./native-context-boundary-fixture.js";

const identity = (selection: ModelSelection) => ({
  providerId: selection.providerId,
  modelId: selection.modelId,
});

async function assertCompletedOwner(
  f: Awaited<ReturnType<typeof modelFreezeFixture>>,
  selected: ModelSelection,
  window: number,
) {
  const records = (await f.store.listNativeContextOperations(PARENT, { limit: 200 })).items;
  const completed = records.find((operation) => operation.kind === "summary");
  assert.equal(completed?.status, "completed");
  assert.deepEqual(completed?.model, identity(selected));
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]?.querySource, "native_context_maintenance");
  assert.deepEqual(f.calls[0]?.selection, selected);
  const rows = await f.observations();
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]?.model, identity(selected));
  assert.equal(rows[0]?.contextWindow, window);
  assert.equal(rows[0]?.inputBudget, window - 1024);
  assert.equal(rows[0]?.actualInputTokens, USAGE.inputTokens);
  assert.equal((await f.store.queryTaskUsage({ sessionID: PARENT })).modelRequestCount, 1);
  assert.equal(
    (await f.store.readTarget({ sessionID: PARENT }))?.tokensUsed,
    getModelUsageTotalTokens(USAGE),
  );
  assert.ok(kernelOf(f.owner.state!).compression.blocks.some((block) => block.active));
}

test("automatic follow-current maintenance uses active execution A while Composer changes from B to C in flight", async (t) => {
  const started = deferred(),
    release = deferred();
  t.after(() => release.resolve());
  const f = await modelFreezeFixture(t, {
    automatic: true,
    onMaintenance: async () => {
      started.resolve();
      await release.promise;
    },
  });
  const activeRequest = f.safePoint(f.selection.A);
  f.runtime.setSessionModelSelection(f.selection.B);
  const pending = prepareNativeContext(f.runtime, activeRequest);
  assert.equal(
    await Promise.race([started.promise.then(() => true), pending.then(() => false)]),
    true,
  );
  assert.deepEqual((await f.observations())[0]?.model, identity(f.selection.A));
  f.runtime.setSessionModelSelection(f.selection.C);
  release.resolve();
  await pending;
  assert.deepEqual(f.runtime.getSessionModelSelection(), f.selection.C);
  await assertCompletedOwner(f, f.selection.A, 32768);
});

test("manual follow-current maintenance freezes clicked B before FIFO dequeue and preserves it after Composer selects C", async (t) => {
  const started = deferred(),
    release = deferred();
  t.after(() => release.resolve());
  const f = await modelFreezeFixture(t, {
    onMaintenance: async () => {
      started.resolve();
      await release.promise;
    },
  });
  f.runtime.setSessionModelSelection(f.selection.B);
  f.runtime.runtimeCommandDrainActive = true;
  const request = f.input(f.runtime.getSessionModelSelection()!, "freeze-manual-B");
  const ack = await compressNativeContext.call(f.runtime, request);
  assert.equal(ack.operation?.status, "preparing");
  assert.deepEqual(ack.operation?.model, identity(f.selection.B));
  assert.equal(f.calls.length, 0);
  f.runtime.setSessionModelSelection(f.selection.C);
  f.runtime.runtimeCommandDrainActive = false;
  const pending = f.runtime.drainRuntimeCommandQueue();
  assert.equal(
    await Promise.race([started.promise.then(() => true), pending.then(() => false)]),
    true,
  );
  assert.deepEqual((await f.observations())[0]?.model, identity(f.selection.B));
  f.runtime.setSessionModelSelection(f.selection.C);
  release.resolve();
  await pending;
  assert.deepEqual(f.runtime.getSessionModelSelection(), f.selection.C);
  await assertCompletedOwner(f, f.selection.B, 65536);
  assert.equal(
    f.resolutions.some((chosen) => chosen.providerId === f.selection.C.providerId),
    false,
  );
});

test("an explicitly configured maintenance B stays separate from execution A and later Composer C", async (t) => {
  const started = deferred(),
    release = deferred();
  t.after(() => release.resolve());
  const f = await modelFreezeFixture(t, {
    automatic: true,
    onMaintenance: async () => {
      started.resolve();
      await release.promise;
    },
  });
  await writeNativeState(f.owner, (state) => {
    state.policy.parameters.maintenance.model = f.selection.B;
  });
  const pending = prepareNativeContext(f.runtime, f.safePoint(f.selection.A));
  assert.equal(
    await Promise.race([started.promise.then(() => true), pending.then(() => false)]),
    true,
  );
  f.runtime.setSessionModelSelection(f.selection.C);
  release.resolve();
  await pending;
  await assertCompletedOwner(f, f.selection.B, 65536);
  assert.deepEqual(f.owner.state!.policy.parameters.maintenance.model, f.selection.B);
});

test("switching the execution model to a small window validates its new budget before any paid maintenance", async (t) => {
  const f = await modelFreezeFixture(t, { automatic: true });
  await writeNativeState(f.owner, (state) => {
    state.policy.parameters.trigger.start = { kind: "tokens", value: 6000 };
    state.policy.parameters.trigger.target = { kind: "tokens", value: 1000 };
    state.policy.parameters.trigger.opportunisticPercent = 1;
  });
  f.runtime.setSessionModelSelection(f.selection.small);
  await assert.rejects(
    prepareNativeContext(f.runtime, f.safePoint(f.selection.small)),
    (error) =>
      error instanceof NativeContextRuntimeError &&
      error.code === "invalid-state" &&
      error.reason === "model-threshold-capacity",
  );
  assert.equal(f.calls.length, 0);
  assert.equal((await f.observations()).length, 0);
  assert.equal((await f.store.queryTaskUsage({ sessionID: PARENT })).modelRequestCount, 0);
  assert.deepEqual(f.runtime.getSessionModelSelection(), f.selection.small);
  assert.equal(kernelOf(f.owner.state!).compression.blocks.length, 0);
});

test("an unavailable configured maintenance selection fails without falling back to current or another Provider", async (t) => {
  const f = await modelFreezeFixture(t, { automatic: true });
  await writeNativeState(f.owner, (state) => {
    state.policy.parameters.maintenance.model = f.selection.unavailable;
  });
  await prepareNativeContext(f.runtime, f.safePoint(f.selection.A));
  const records = (await f.store.listNativeContextOperations(PARENT, { limit: 200 })).items;
  assert.equal(records.find((operation) => operation.kind === "summary")?.status, "error");
  assert.ok(
    f.resolutions.some((chosen) => chosen.providerId === f.selection.unavailable.providerId),
  );
  assert.equal(f.calls.length, 0);
  assert.equal((await f.observations()).length, 0);
  assert.deepEqual(f.owner.state!.policy.parameters.maintenance.model, f.selection.unavailable);
  assert.deepEqual(f.runtime.getSessionModelSelection(), f.selection.A);
});

test("an unavailable clicked manual selection is rejected before admission without using a valid current model", async (t) => {
  const f = await modelFreezeFixture(t);
  await assert.rejects(
    compressNativeContext.call(
      f.runtime,
      f.input(f.selection.unavailable, "freeze-manual-missing"),
    ),
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.runtime.runtimeCommandQueue.size(), 0);
  assert.equal((await f.store.listNativeContextOperations(PARENT, { limit: 200 })).items.length, 0);
  assert.deepEqual(f.runtime.getSessionModelSelection(), f.selection.A);
  assert.equal(
    f.resolutions.some((chosen) => chosen.providerId !== f.selection.unavailable.providerId),
    false,
  );
});

test("a selected maintenance output budget above its real limit is unavailable and never triggers a fallback request", async (t) => {
  const f = await modelFreezeFixture(t, { automatic: true });
  await writeNativeState(f.owner, (state) => {
    state.policy.parameters.maintenance.model = f.selection.B;
    state.policy.parameters.maintenance.maxOutputTokens = 2048;
  });
  await prepareNativeContext(f.runtime, f.safePoint(f.selection.A));
  const records = (await f.store.listNativeContextOperations(PARENT, { limit: 200 })).items;
  const operation = records.find((item) => item.kind === "summary");
  assert.equal(operation?.status, "no-benefit");
  assert.equal(operation?.reason, "unsupported");
  assert.deepEqual(operation?.model, identity(f.selection.B));
  assert.equal(f.calls.length, 0);
  assert.equal((await f.observations()).length, 0);
  assert.deepEqual(f.owner.state!.policy.parameters.maintenance.model, f.selection.B);
});
