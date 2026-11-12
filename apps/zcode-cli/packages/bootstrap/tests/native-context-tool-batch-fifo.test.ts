import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionEventType, type TurnCompletePayload } from "@zcode/contracts";
import {
  nativeContextObservationsPageSchema,
  nativeContextStatusSchema,
} from "@zcode/shared/native-context-compression";
import { V4_METHODS } from "@zcode/shared/zcode-protocol-v4";
import {
  batchToolParts,
  createBootstrapBatchFixture,
} from "./native-context-tool-batch-fifo-fixture.js";
import {
  BATCH_CALL_IDS,
  BATCH_FINAL_TEXT,
  BATCH_FIRST_INPUT,
  BATCH_MAIN,
  BATCH_MAINTENANCE,
  BATCH_MAINTENANCE_USAGE,
  BATCH_SECOND_INPUT,
  BATCH_SUMMARY,
} from "./native-context-tool-batch-model.js";

for (const clientMode of ["desktop-continuous", "web-remote-replayable"] as const) {
  test(
    `NCTX09 actual Bootstrap ${clientMode}: tool batch gates durable manual ACK and ordinary FIFO`,
    { timeout: 30_000 },
    async (t) => {
      const f = await createBootstrapBatchFixture(t, clientMode);
      const mainDone = f.completion("bootstrap-batch-turn");
      const started = await f.command("sendText", "bootstrap-batch-turn", {
        text: "NCTX09_REAL_TOOL_BATCH: collect both read-only observations and answer.",
        modelSelection: BATCH_MAIN,
      });
      assert.equal(started.status, "accepted");
      assert.equal(started.result?.type, "inputAccepted");
      await f.waitFor(Promise.all(f.tools.map((gate) => gate.entered.promise)));
      const unfinished = batchToolParts(await f.store.messages({ sessionID: f.sessionId }));
      assert.deepEqual(
        unfinished.map((part) => part.callID),
        BATCH_CALL_IDS,
      );
      assert.deepEqual(
        unfinished.map((part) => part.state.status),
        ["running", "running"],
      );

      // 只有真正两个 ToolEntry 均在执行时才提交维护；ACK 必须在 release 之前完成。
      const manual = await f.command("contextCompression.compress", "bootstrap-manual", {
        model: BATCH_MAINTENANCE,
      });
      assert.equal(manual.status, "accepted");
      const admittedState = await f.freezeAdmission();
      assert.ok(admittedState);
      const operations = await f.store.listNativeContextOperations(f.sessionId, { limit: 200 });
      assert.equal(operations.items.length, 1);
      const preparing = await f.store.getNativeContextOperation(
        f.sessionId,
        operations.items[0]!.operationId,
      );
      assert.ok(preparing);
      assert.equal(preparing.status, "preparing");
      assert.equal(preparing.historyVersion, admittedState.historyVersion);
      assert.deepEqual(preparing.model, {
        providerId: BATCH_MAINTENANCE.providerId,
        modelId: BATCH_MAINTENANCE.modelId,
      });
      assert.equal(
        f.models.calls.filter((call) => call.model.modelId === BATCH_MAINTENANCE.modelId).length,
        0,
      );
      const duplicate = await f.command("contextCompression.compress", "bootstrap-manual", {
        model: BATCH_MAINTENANCE,
      });
      assert.equal(duplicate.status, "duplicate");
      assert.deepEqual(
        await f.store.getNativeContextOperation(f.sessionId, preparing.operationId),
        preparing,
      );
      assert.deepEqual(await f.store.getNativeContextState(f.sessionId), admittedState);

      const firstDone = f.completion("bootstrap-fifo-first"),
        secondDone = f.completion("bootstrap-fifo-second");
      for (const [commandId, text] of [
        ["bootstrap-fifo-first", BATCH_FIRST_INPUT],
        ["bootstrap-fifo-second", BATCH_SECOND_INPUT],
      ] as const) {
        const ack = await f.command("sendText", commandId, { text, modelSelection: BATCH_MAIN });
        assert.equal(ack.status, "accepted");
        assert.deepEqual(ack.result, {
          type: "inputAccepted",
          delivery: "queue",
          inputId: commandId,
        });
      }
      const queued = (
        await f.store.listSessionInputs({ sessionID: f.sessionId, status: "admitted" })
      ).filter(
        (item) =>
          item.payload.text === BATCH_FIRST_INPUT || item.payload.text === BATCH_SECOND_INPUT,
      );
      assert.deepEqual(
        queued.map((item) => item.payload.text),
        [BATCH_FIRST_INPUT, BATCH_SECOND_INPUT],
      );
      assert.ok(queued[0]!.admittedSequence < queued[1]!.admittedSequence);
      assert.ok(queued.every((item) => item.promotedMessageID === undefined));
      assert.equal(
        (await f.store.listNativeContextOperations(f.sessionId, { limit: 200 })).items.length,
        1,
      );

      f.tools[0]!.release.resolve();
      await f.waitFor(f.firstToolResult.promise);
      const partial = batchToolParts(await f.store.messages({ sessionID: f.sessionId }));
      assert.equal(
        partial.find((part) => part.callID === BATCH_CALL_IDS[1])?.state.status,
        "running",
      );
      assert.equal(f.models.calls.length, 2, "first tool result must not release the whole batch");
      assert.equal(
        (await f.store.getNativeContextOperation(f.sessionId, preparing.operationId))?.status,
        "preparing",
      );
      assert.deepEqual(
        (await f.store.listSessionInputs({ sessionID: f.sessionId, status: "admitted" })).filter(
          (item) => queued.some((original) => original.id === item.id),
        ),
        queued,
      );

      f.tools[1]!.release.resolve();
      await f.waitFor(f.finalEntered.promise);
      assert.equal(f.models.calls.length, 3, "final assistant is still the same foreground turn");
      assert.equal(
        (await f.store.getNativeContextOperation(f.sessionId, preparing.operationId))?.status,
        "preparing",
      );
      assert.ok(!f.order.includes("maintenance-model"));
      f.finalRelease.resolve();
      await f.waitFor(mainDone);
      await f.waitFor(f.maintenanceEntered.promise);
      assert.ok(
        f.order.indexOf("complete:bootstrap-batch-turn") < f.order.indexOf("maintenance-model"),
      );
      const running = await f.store.getNativeContextOperation(f.sessionId, preparing.operationId);
      const snapshots = f.snapshots();
      assert.ok(snapshots.runningState && snapshots.admissionState);
      assert.ok(running);
      assert.equal(running.status, "running");
      assert.notEqual(running.historyVersion, preparing.historyVersion);
      assert.equal(running.historyVersion, snapshots.runningState.historyVersion);
      assert.equal(running.anchorMessageId, snapshots.maintenanceMessages.at(-1)!.info.id);
      const final = snapshots.maintenanceMessages.at(-1)!;
      assert.ok(final.info.role === "assistant");
      assert.ok(final.parts.some((part) => part.type === "text" && part.text === BATCH_FINAL_TEXT));
      assert.ok(final.parts.some((part) => part.type === "step-finish"));
      assert.ok(final.info.time.completed);
      assert.deepEqual(
        (await f.store.listSessionInputs({ sessionID: f.sessionId, status: "admitted" })).filter(
          (item) => queued.some((original) => original.id === item.id),
        ),
        queued,
        "ordinary input must remain unpromoted while native maintenance owns foreground",
      );

      f.maintenanceRelease.resolve();
      await f.waitFor(f.maintenanceSettled.promise);
      await f.waitFor(Promise.all([firstDone, secondDone]));
      const complete = await f.store.getNativeContextOperation(f.sessionId, preparing.operationId);
      assert.ok(complete);
      assert.equal(complete.status, "completed");
      assert.equal(complete.historyVersion, running.historyVersion);
      assert.equal(complete.anchorMessageId, running.anchorMessageId);
      assert.ok(
        complete.afterEstimate !== null &&
          complete.beforeEstimate !== null &&
          complete.afterEstimate < complete.beforeEstimate,
      );
      assert.ok(complete.sources.length > 0);
      assert.ok(complete.summary.includes(BATCH_SUMMARY));
      const maintenance = nativeContextObservationsPageSchema.parse(
        await f.query(V4_METHODS.contextCompressionObservations, {
          sessionId: f.sessionId,
          purpose: "maintenance",
          limit: 200,
        }),
      );
      assert.equal(maintenance.items.length, 1);
      assert.equal(maintenance.items[0]!.status, "completed");
      assert.equal(maintenance.items[0]!.actualInputTokens, BATCH_MAINTENANCE_USAGE.inputTokens);
      assert.equal(maintenance.items[0]!.outputTokens, BATCH_MAINTENANCE_USAGE.outputTokens);
      assert.deepEqual(maintenance.items[0]!.operationIds, [preparing.operationId]);
      assert.equal(f.models.calls.length, 6);
      assert.equal(
        f.models.calls.filter((call) => call.model.modelId === BATCH_MAINTENANCE.modelId).length,
        1,
      );
      assert.deepEqual(
        f.order.filter((item) => item.endsWith("-model")),
        ["maintenance-model", "fifo-first-model", "fifo-second-model"],
      );
      const promoted = (
        await f.store.listSessionInputs({ sessionID: f.sessionId, status: "promoted" })
      ).filter((item) => queued.some((original) => original.id === item.id));
      assert.deepEqual(
        promoted.map((item) => item.id),
        queued.map((item) => item.id),
      );
      assert.ok(promoted[0]!.promotedSequence! < promoted[1]!.promotedSequence!);
      const messages = await f.store.messages({ sessionID: f.sessionId });
      for (const item of promoted) {
        const user = messages.find((message) => message.info.id === item.promotedMessageID);
        assert.ok(user);
        assert.equal(user.info.role, "user");
        assert.ok(
          user.parts.some((part) => part.type === "text" && part.text === item.payload.text),
        );
      }
      const completedInputs = f.events
        .filter((event) => event.type === SessionEventType.TurnComplete)
        .map((event) => (event.payload as TurnCompletePayload).inputId);
      assert.deepEqual(completedInputs, [
        "bootstrap-seed",
        "bootstrap-batch-turn",
        "bootstrap-fifo-first",
        "bootstrap-fifo-second",
      ]);
      const status = nativeContextStatusSchema.parse(
        await f.query(V4_METHODS.contextCompressionGet, { sessionId: f.sessionId }),
      );
      assert.equal(status.phase, "idle");
      assert.equal(status.policy.mode, "manual");
      const finalDuplicate = await f.command("contextCompression.compress", "bootstrap-manual", {
        model: BATCH_MAINTENANCE,
      });
      assert.equal(finalDuplicate.status, "duplicate");
      assert.deepEqual(
        await f.store.getNativeContextOperation(f.sessionId, preparing.operationId),
        complete,
      );
      assert.equal(f.models.calls.length, 6);
    },
  );
}
