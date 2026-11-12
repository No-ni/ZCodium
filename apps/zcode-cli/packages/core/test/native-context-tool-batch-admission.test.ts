import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { nativeOwner, kernelOf } from "../src/runtime/native-context-compression/state.js";
import {
  createNctxToolBatchFixture,
  nctxBatchToolParts,
} from "./native-context-tool-batch-fixture.js";
import {
  NCTX_BATCH_CALL_IDS,
  NCTX_BATCH_FINAL_TEXT,
  NCTX_BATCH_MAIN,
  NCTX_BATCH_MAINTENANCE,
  NCTX_BATCH_MAINTENANCE_USAGE,
} from "./native-context-tool-batch-model.js";

test(
  "NCTX-09 real unfinished ToolPart batch ACKs one durable manual receipt, deduplicates and runs only after complete main settlement",
  { timeout: 30000 },
  async (t) => {
    const f = await createNctxToolBatchFixture(t);
    const internal = f.runtime as unknown as AgentRuntimeInternal;
    const mainTurn = f.startMain();
    await Promise.race([
      Promise.all(f.gates.map((gate) => gate.entered.promise)),
      mainTurn.then(
        () => assert.fail("the main turn must not complete before either real tool gate opens"),
        (error: unknown) => {
          throw error instanceof Error ? (error.cause ?? error) : error;
        },
      ),
    ]);
    const activeForegroundId = f.runtime.getActiveForegroundExecutionId();
    assert.ok(activeForegroundId);
    const runningMessages = await f.store.messages({ sessionID: f.sessionId });
    const running = nctxBatchToolParts(runningMessages);
    assert.deepEqual(
      running.map((part) => [part.callID, part.state.status]),
      NCTX_BATCH_CALL_IDS.map((id) => [id, "running"]),
    );
    assert.equal(
      f.events.filter((event) => event.type === SessionEventType.ToolBatchComplete).length,
      0,
    );
    const admissionHistoryVersion = (await f.runtime.getNativeContextCompression()).historyVersion;
    const outcomes = await Promise.all([
      f.runtime.compressNativeContext(f.input),
      f.runtime.compressNativeContext(f.input),
      f.runtime.compressNativeContext(f.input),
    ]);
    const operation = outcomes[0]!.operation;
    assert.ok(operation);
    assert.deepEqual(
      outcomes.map((outcome) => outcome.operation),
      [operation, operation, operation],
    );
    assert.equal(operation.status, "preparing");
    assert.equal(operation.historyVersion, admissionHistoryVersion);
    assert.deepEqual(
      await f.store.getNativeContextOperation(f.sessionId, operation.operationId),
      operation,
    );
    assert.equal((await f.store.listNativeContextOperations(f.sessionId, {})).items.length, 1);
    assert.equal(
      f.models.calls.filter((call) => call.model.modelId === NCTX_BATCH_MAINTENANCE.modelId).length,
      0,
    );
    assert.equal(
      (await f.store.listNativeContextObservations(f.sessionId, { purpose: "maintenance" })).items
        .length,
      0,
    );
    assert.deepEqual(
      internal.runtimeCommandQueue.snapshot().map((command) => [command.mode, command.priority]),
      [["native-context-maintenance", "later"]],
    );
    assert.equal(f.runtime.getActiveForegroundExecutionId(), activeForegroundId);
    assert.equal(internal.activeForegroundExecution?.controller.signal.aborted, false);

    f.gates[0]!.release.resolve();
    await f.firstResult.promise;
    assert.equal(f.order.includes("tool-second-returned"), false);
    assert.equal(
      f.events.filter((event) => event.type === SessionEventType.ToolBatchComplete).length,
      0,
    );
    // 单项 handler 已返回，但当前真实 batch 未完成，不能把事件误当成整批结果已持久化。
    assert.equal(
      nctxBatchToolParts(await f.store.messages({ sessionID: f.sessionId }))[1]!.state.status,
      "running",
    );
    assert.equal(f.models.calls.length, 2);
    assert.equal(
      (await f.store.getNativeContextOperation(f.sessionId, operation.operationId))!.status,
      "preparing",
    );

    f.gates[1]!.release.resolve();
    await f.finalEntered.promise;
    assert.deepEqual(
      nctxBatchToolParts(await f.store.messages({ sessionID: f.sessionId })).map(
        (part) => part.state.status,
      ),
      ["completed", "completed"],
    );
    assert.equal(
      f.events.filter((event) => event.type === SessionEventType.ToolBatchComplete).length,
      1,
    );
    assert.equal(f.models.calls.length, 3);
    assert.equal(
      f.models.calls.every((call) => call.model.modelId === NCTX_BATCH_MAIN.modelId),
      true,
    );
    assert.equal(
      (await f.store.getNativeContextOperation(f.sessionId, operation.operationId))!.status,
      "preparing",
    );
    assert.equal(f.runtime.getActiveForegroundExecutionId(), activeForegroundId);
    assert.equal(internal.activeForegroundExecution?.controller.signal.aborted, false);

    f.finalRelease.resolve();
    await mainTurn;
    await f.maintenanceEntered.promise;
    const snapshot = f.snapshots();
    assert.notEqual(snapshot.completedHistoryVersion, admissionHistoryVersion);
    assert.equal(snapshot.completedHistoryVersion, snapshot.maintenanceHistoryVersion);
    const current = await f.store.getNativeContextOperation(f.sessionId, operation.operationId);
    assert.equal(current!.status, "running");
    assert.equal(current!.historyVersion, snapshot.completedHistoryVersion);
    assert.deepEqual(current!.model, NCTX_BATCH_MAINTENANCE);
    assert.ok(f.order.lastIndexOf("main-complete") < f.order.indexOf("maintenance-start"));
    const finalMain = snapshot.maintenanceMessages.at(-1)!;
    assert.equal(finalMain.info.role, "assistant");
    assert.ok(finalMain.info.time.completed);
    assert.ok(
      finalMain.parts.some((part) => part.type === "text" && part.text === NCTX_BATCH_FINAL_TEXT),
    );
    const entries = internal.messageHistory.borrowReadOnlyRuntimeEntries();
    for (const part of nctxBatchToolParts(snapshot.maintenanceMessages)) {
      const producers = entries.filter(
        (entry) =>
          entry.kind !== "attachment" &&
          entry.message.toolCalls?.some((call) => call.id === part.callID),
      );
      const results = entries.filter(
        (entry) => entry.kind !== "attachment" && entry.message.toolCallId === part.callID,
      );
      assert.equal(producers.length, 1);
      assert.equal(results.length, 1);
      assert.equal(results[0]!.canonical?.partId, part.id);
      assert.equal(results[0]!.canonical?.messageId, part.messageID);
      assert.ok(nativeOwner(internal).state!.sources.some((source) => source.partId === part.id));
    }

    f.maintenanceRelease.resolve();
    await f.maintenanceSettled.promise;
    await f.settledDrains();
    const bundle = await f.store.getNativeContextForkBundle(f.sessionId);
    assert.ok(bundle);
    assert.equal(bundle.operations.length, 1);
    const terminal = bundle.operations[0]!;
    assert.equal(terminal.operationId, operation.operationId);
    assert.equal(terminal.status, "completed");
    assert.equal(terminal.reason, null);
    assert.equal(terminal.historyVersion, snapshot.completedHistoryVersion);
    assert.equal(terminal.blockIds.length > 0, true);
    assert.ok(kernelOf(bundle.state).compression.blocks.some((block) => block.active));
    const paid = bundle.observations.filter((observation) => observation.purpose === "maintenance");
    assert.equal(paid.length, 1);
    assert.equal(paid[0]!.status, "completed");
    assert.equal(paid[0]!.historyVersion, snapshot.completedHistoryVersion);
    assert.equal(paid[0]!.model.modelId, NCTX_BATCH_MAINTENANCE.modelId);
    assert.deepEqual(
      [paid[0]!.actualInputTokens, paid[0]!.outputTokens, paid[0]!.cacheReadTokens],
      [NCTX_BATCH_MAINTENANCE_USAGE.inputTokens, NCTX_BATCH_MAINTENANCE_USAGE.outputTokens, 0],
    );
    assert.deepEqual(paid[0]!.operationIds, [operation.operationId]);
    assert.deepEqual(terminal.observationIds, [paid[0]!.id]);
    assert.deepEqual(
      await f.store.messages({ sessionID: f.sessionId }),
      snapshot.maintenanceMessages,
    );
    assert.deepEqual(
      snapshot.maintenanceMessages.slice(0, f.initialMessages.length),
      f.initialMessages,
    );
    const beforeReplay = structuredClone(bundle);
    const duplicate = await f.runtime.compressNativeContext(f.input);
    assert.equal(duplicate.operation?.operationId, operation.operationId);
    assert.deepEqual(await f.store.getNativeContextForkBundle(f.sessionId), beforeReplay);
    assert.equal(f.models.calls.length, 4);
    assert.equal(
      f.models.calls.filter((call) => call.querySource === "native_context_maintenance").length,
      1,
    );
    assert.deepEqual(internal.runtimeCommandQueue.snapshot(), []);
    assert.equal(f.runtime.getActiveForegroundExecutionId(), undefined);
  },
);
