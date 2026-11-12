import assert from "node:assert/strict";
import test from "node:test";
import { compressNativeContext } from "../src/runtime/native-context-compression/controller.js";
import { NativeContextRuntimeError } from "../src/runtime/native-context-compression/contract.js";
import { nativeStatus, writeNativeState } from "../src/runtime/native-context-compression/state.js";
import {
  deferred,
  maintenanceFixture,
  summaryResult,
} from "./native-context-maintenance-fixture.js";
import { PARENT } from "./native-context-boundary-fixture.js";
import { stopActiveForegroundExecution } from "../src/runtime/methods/runtime-command-queue.js";

function input(
  f: Awaited<ReturnType<typeof maintenanceFixture>>,
  commandId: string,
  abort = new AbortController(),
) {
  return {
    model: { providerId: f.model.providerId, modelId: f.model.modelId },
    commandId,
    abortSignal: abort.signal,
    traceContext: f.host.rootTraceContext,
  };
}

test("manual admission returns a durable preparing receipt before foreground work and runs once in the same FIFO", async (t) => {
  const f = await maintenanceFixture(t);
  f.host.runtimeCommandDrainActive = true;
  f.enqueuePrompt("earlier-prompt");
  const request = input(f, "manual-fixture-command");
  const [ack, duplicate] = await Promise.all([
    compressNativeContext.call(f.host, request),
    compressNativeContext.call(f.host, request),
  ]);
  assert.equal(ack.operation?.status, "preparing");
  assert.equal(ack.status.phase, "compressing");
  assert.equal(duplicate.operation?.operationId, ack.operation?.operationId);
  assert.equal(f.calls.length, 0);
  assert.equal(f.host.runtimeCommandQueue.size(), 2);
  assert.equal(
    (await f.store.getNativeContextOperation(PARENT, ack.operation!.operationId))?.status,
    "preparing",
  );
  f.enqueuePrompt("later-prompt");
  f.host.runtimeCommandDrainActive = false;
  await f.host.drainRuntimeCommandQueue();
  assert.deepEqual(f.order, ["earlier-prompt", "maintenance", "later-prompt"]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.host.runtimeCommandQueue.size(), 0);
  assert.equal(f.host.activeForegroundExecution, undefined);
  assert.equal(f.owner.phase, "idle");
  assert.equal(
    (await f.store.getNativeContextOperation(PARENT, ack.operation!.operationId))?.status,
    "completed",
  );
  await compressNativeContext.call(f.host, request);
  f.owner.commandResults?.clear();
  const recovered = await compressNativeContext.call(f.host, request);
  assert.equal(recovered.operation?.status, "completed");
  assert.equal(f.calls.length, 1);
  assert.equal(f.host.runtimeCommandQueue.size(), 0);
});

test("an idle manual request acknowledges admission while its real model call is still waiting", async (t) => {
  const started = deferred(),
    release = deferred();
  const f = await maintenanceFixture(t, async ({ request }) => {
    started.resolve();
    await release.promise;
    return { text: summaryResult(request.messages) };
  });
  const ack = await compressNativeContext.call(f.host, input(f, "manual-immediate-ack"));
  assert.equal(ack.status.phase, "compressing");
  const activeDrain = f.drains.at(-1)!;
  const reachedModel = await Promise.race([
    started.promise.then(() => true),
    activeDrain.then(() => false),
  ]);
  assert.equal(
    reachedModel,
    true,
    "admitted command ended before the real provider request started",
  );
  assert.equal((await f.observations())[0]?.status, "prepared");
  release.resolve();
  await activeDrain;
  assert.equal(
    (await f.store.getNativeContextOperation(PARENT, ack.operation!.operationId))?.status,
    "completed",
  );
  assert.equal(f.owner.phase, "idle");
});

test("running native maintenance exposes only the existing foreground execution and clears its transient Stop evidence", async (t) => {
  const started = deferred(),
    release = deferred();
  const f = await maintenanceFixture(t, async ({ request }) => {
    started.resolve();
    await release.promise;
    return { text: summaryResult(request.messages) };
  });
  f.host.runtimeCommandDrainActive = true;
  const ack = await compressNativeContext.call(f.host, input(f, "manual-stop-projection"));
  assert.equal(ack.operation?.status, "preparing");
  assert.equal(nativeStatus(f.owner).activeMaintenance, undefined);
  f.host.runtimeCommandDrainActive = false;
  const drain = f.host.drainRuntimeCommandQueue();
  try {
    await started.promise;
    const current = nativeStatus(f.owner);
    assert.equal(
      current.activeMaintenance?.foregroundExecutionId,
      f.host.activeForegroundExecution?.foregroundExecutionId,
    );
    assert.ok(
      current.activeMaintenance,
      "real running maintenance needs a stoppable execution proof",
    );
    assert.ok(current.activeMaintenance.startedAt <= Date.now());
    assert.equal(current.phase, "compressing");
  } finally {
    release.resolve();
    await drain;
  }
  assert.equal(nativeStatus(f.owner).activeMaintenance, undefined);
  assert.equal(f.host.activeForegroundExecution, undefined);
});

test("native Stop execution proof uses the existing mismatch guard and cancels the same real maintenance", async (t) => {
  const started = deferred(),
    release = deferred();
  const f = await maintenanceFixture(t, async ({ request }) => {
    started.resolve();
    await release.promise;
    return { text: summaryResult(request.messages) };
  });
  const ack = await compressNativeContext.call(f.host, input(f, "manual-stop-execution"));
  const drain = f.drains.at(-1)!;
  try {
    await started.promise;
    const proof = nativeStatus(f.owner).activeMaintenance;
    assert.ok(proof);
    assert.equal(
      stopActiveForegroundExecution.call(f.host, {
        expectedForegroundExecutionId: "obsolete-execution",
      }).kind,
      "mismatch",
    );
    assert.equal(f.host.activeForegroundExecution?.controller.signal.aborted, false);
    assert.equal(
      stopActiveForegroundExecution.call(f.host, {
        expectedForegroundExecutionId: proof.foregroundExecutionId,
      }).kind,
      "stopped",
    );
    assert.equal(f.host.activeForegroundExecution?.controller.signal.aborted, true);
  } finally {
    release.resolve();
    await drain;
  }
  assert.equal(
    (await f.store.getNativeContextOperation(PARENT, ack.operation!.operationId))?.status,
    "cancelled",
  );
  assert.equal(nativeStatus(f.owner).activeMaintenance, undefined);
});

test("a second distinct manual command is rejected while the admitted operation owns the shared phase", async (t) => {
  const f = await maintenanceFixture(t);
  f.host.runtimeCommandDrainActive = true;
  await compressNativeContext.call(f.host, input(f, "manual-first"));
  await assert.rejects(
    compressNativeContext.call(f.host, input(f, "manual-second")),
    (error) => error instanceof NativeContextRuntimeError && error.code === "busy",
  );
  assert.equal(f.host.runtimeCommandQueue.size(), 1);
  assert.equal(f.calls.length, 0);
  f.host.runtimeCommandDrainActive = false;
  await f.host.drainRuntimeCommandQueue();
  assert.equal(f.owner.phase, "idle");
});

test("cancelling admitted queued maintenance releases its phase without starting a provider request", async (t) => {
  const f = await maintenanceFixture(t);
  f.host.runtimeCommandDrainActive = true;
  const abort = new AbortController();
  const ack = await compressNativeContext.call(f.host, input(f, "manual-queued-cancel", abort));
  abort.abort(new Error("synthetic queued stop"));
  f.host.runtimeCommandDrainActive = false;
  await f.host.drainRuntimeCommandQueue();
  assert.equal(
    (await f.store.getNativeContextOperation(PARENT, ack.operation!.operationId))?.status,
    "cancelled",
  );
  assert.equal(f.calls.length, 0);
  assert.equal((await f.observations()).length, 0);
  assert.equal(f.owner.phase, "idle");
});

test("manual execution reads canonical history at dequeue rather than reusing the admission snapshot", async (t) => {
  const f = await maintenanceFixture(t);
  f.host.runtimeCommandDrainActive = true;
  const ack = await compressNativeContext.call(f.host, input(f, "manual-new-history"));
  const admissionVersion = ack.operation!.historyVersion;
  await f.appendHistory();
  await writeNativeState(f.owner, (candidate) => {
    candidate.requestSeq = 7;
    candidate.policy.policyVersion += 1;
    candidate.policy.parameters.summary.minReductionPercent += 1;
  });
  const actualVersion = f.owner.state!.historyVersion;
  assert.notEqual(actualVersion, admissionVersion);
  f.host.runtimeCommandDrainActive = false;
  await f.host.drainRuntimeCommandQueue();
  const final = await f.store.getNativeContextOperation(PARENT, ack.operation!.operationId);
  assert.equal(final?.status, "completed");
  assert.equal(final?.historyVersion, actualVersion);
  assert.equal(final?.policyVersion, 4);
  assert.equal(final?.anchorRequestSeq, 7);
  assert.equal(final?.anchorMessageId, f.host.latestConversationMessageId);
  assert.equal((await f.observations())[0]?.historyVersion, actualVersion);
});
