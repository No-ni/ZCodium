import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType } from "@zcode/contracts";
import { kernelOf } from "../src/runtime/native-context-compression/state.js";
import {
  mainRequestFixture,
  requestText,
  ANSWER,
  OLD_TEXT,
  SUMMARY,
  USAGE,
} from "./native-context-main-request-fixture.js";
import { PARENT } from "./native-context-boundary-fixture.js";

test("the actual model step sends committed compression, freezes before/after observations and bills one physical request", async (t) => {
  const f = await mainRequestFixture(t);
  assert.equal(await f.run(), "break");
  assert.equal(f.calls.length, 1);
  assert.ok(requestText(f.comparison.baselineMessages).includes(OLD_TEXT));
  const sent = requestText(f.calls[0]!.request.messages);
  assert.ok(sent.includes(SUMMARY));
  assert.ok(sent.includes("main-latest-user"));
  assert.equal(sent.includes(OLD_TEXT), false);
  assert.deepEqual(
    f.runtime.messageHistory.borrowReadOnlyRuntimeEntries().slice(0, f.original.length),
    f.original,
  );
  const initial = f.prepared[0]!;
  const [point] = await f.rows();
  assert.ok(point);
  assert.equal(f.prepared.length, 1);
  assert.equal(initial.status, "prepared");
  assert.ok(
    initial.beforeEstimate !== null &&
      initial.afterEstimate !== null &&
      initial.beforeEstimate > initial.afterEstimate,
  );
  assert.equal(point.beforeEstimate, initial.beforeEstimate);
  assert.equal(point.afterEstimate, initial.afterEstimate);
  assert.equal(point.policyVersion, f.comparison.policyVersion);
  assert.equal(point.historyVersion, f.comparison.historyVersion);
  assert.equal(point.requestSeq, 1);
  assert.equal(point.status, "completed");
  assert.equal(point.actualInputTokens, USAGE.inputTokens);
  assert.equal(point.outputTokens, USAGE.outputTokens);
  assert.equal(point.cacheReadTokens, 0);
  assert.deepEqual(point.operationIds, ["seed-compression"]);
  assert.equal(point.id, "usage_model_main_turn_main-physical-1_0");
  const response = await f.response();
  assert.ok(response && response.info.role === "assistant");
  assert.equal(initial.anchorMessageId, response.info.id);
  assert.equal(point.anchorMessageId, response.info.id);
  assert.equal(response.info.finish, "stop");
  assert.ok(Number.isFinite(response.info.time.completed));
  assert.equal(f.usages.length, 1);
  assert.equal(f.usages[0]?.id, point.usageRecordRef);
  assert.equal(f.usages[0]?.assistantMessageID, response.info.id);
  const usage = await f.store.queryTaskUsage({ sessionID: PARENT });
  assert.equal(usage.modelRequestCount, 1);
  assert.equal(usage.inputTokens, USAGE.inputTokens);
  assert.equal(f.loop.modelResponse, ANSWER);
});

test("a real streamed image request commits its staged copy only after step-finish and assistant completion become durable", async (t) => {
  const f = await mainRequestFixture(t, {
    images: true,
    streaming: true,
    holdAssistantCompletion: true,
  });
  const running = f.run();
  await f.completionReached.promise;
  const pending = await f.response();
  assert.ok(pending && pending.info.role === "assistant");
  assert.equal(pending.info.time.completed, undefined);
  assert.ok(pending.parts.some((part) => part.type === "step-finish"));
  assert.equal(f.receiptWrites.length, 0);
  assert.deepEqual((await f.store.getNativeContextState(PARENT))?.imageReceipts, []);
  const content = f.calls[0]!.request.messages.flatMap((message) =>
    Array.isArray(message.content) ? message.content : [],
  );
  const image = content.find((block) => block.type === "image");
  assert.ok(image?.type === "image");
  assert.equal(Buffer.from(image.dataUrl.split(",")[1]!, "base64").byteLength, 1024);
  const [point] = await f.rows();
  assert.ok(point);
  assert.equal(point.anchorMessageId, pending.info.id);
  assert.equal(point.status, "completed");
  assert.equal(point.beforeEstimate, null);
  assert.equal(point.afterEstimate, null);
  assert.ok(
    point.textBeforeEstimate !== null &&
      point.textAfterEstimate !== null &&
      point.textBeforeEstimate > point.textAfterEstimate,
  );
  assert.equal(point.visionTokens, null);
  assert.equal(point.images.beforeBytes, 8192);
  assert.equal(point.images.afterBytes, 1024);
  assert.equal(point.images.sentCount, 1);
  assert.equal(point.images.resizedCount, 1);
  assert.equal(point.actualInputTokens, USAGE.inputTokens);
  f.releaseCompletion.resolve();
  assert.equal(await running, "break");
  const committed = await f.store.getNativeContextState(PARENT);
  assert.ok(committed);
  assert.equal(f.receiptWrites.length, 1);
  assert.equal(committed.imageReceipts.length, 1);
  assert.equal(committed.imageReceipts[0]?.logicalRequestId, "main-physical-1");
  assert.equal(committed.imageReceipts[0]?.responseMessageId, pending.info.id);
  assert.equal(Object.values(kernelOf(committed).imageViews ?? {})[0]?.bytes, 1024);
  assert.ok(f.order.indexOf("step-finish-durable") < f.order.indexOf("assistant-complete-durable"));
  assert.ok(
    f.order.indexOf("assistant-complete-durable") < f.order.indexOf("image-receipt-attempt"),
  );
  const original = await f.store.messageWithParts({
    sessionID: PARENT,
    messageID: f.messages.at(-1)!.info.id,
  });
  assert.deepEqual(original, f.messages.at(-1));
});

for (const rejectAt of ["step-finish", "assistant-complete"] as const) {
  test(
    "a failed " +
      rejectAt +
      " write preserves paid model usage without attempting an image receipt",
    async (t) => {
      const f = await mainRequestFixture(t, { images: true, rejectAt });
      await assert.rejects(f.run(), (error) => error === f.rejection);
      const response = await f.response();
      assert.ok(response && response.info.role === "assistant");
      assert.equal(response.info.time.completed, undefined);
      assert.equal(
        response.parts.some((part) => part.type === "step-finish"),
        rejectAt === "assistant-complete",
      );
      assert.equal(f.receiptWrites.length, 0);
      const state = await f.store.getNativeContextState(PARENT);
      assert.ok(state);
      assert.deepEqual(state.imageReceipts, []);
      assert.deepEqual(kernelOf(state).imageViews ?? {}, {});
      const [point] = await f.rows();
      assert.equal(point?.anchorMessageId, response.info.id);
      assert.equal(point?.actualInputTokens, USAGE.inputTokens);
      assert.equal(point?.status, "completed");
      assert.equal(f.usages.length, 1);
      assert.equal(f.usages[0]?.assistantMessageID, response.info.id);
      assert.equal((await f.store.queryTaskUsage({ sessionID: PARENT })).modelRequestCount, 1);
    },
  );
}

test("an image receipt storage failure leaves the durable answer successful and emits only the stable receipt diagnostic", async (t) => {
  const f = await mainRequestFixture(t, { images: true, rejectAt: "image-receipt" });
  assert.equal(await f.run(), "break");
  assert.equal(f.loop.modelResponse, ANSWER);
  assert.equal(f.loop.turnMachine.isComplete(), true);
  const response = await f.response();
  assert.ok(response && response.info.role === "assistant");
  assert.ok(Number.isFinite(response.info.time.completed));
  assert.equal(response.info.finish, "stop");
  assert.equal(response.info.error, undefined);
  assert.ok(response.parts.some((part) => part.type === "step-finish"));
  assert.equal(f.receiptWrites.length, 1);
  assert.deepEqual((await f.store.getNativeContextState(PARENT))?.imageReceipts, []);
  assert.equal(f.usages[0]?.status, "completed");
  assert.equal(
    (await f.store.queryTaskUsage({ sessionID: PARENT })).inputTokens,
    USAGE.inputTokens,
  );
  assert.equal(
    f.events.some(
      (event) =>
        event.type === SessionEventType.ModelNetworkStatus &&
        typeof event.payload === "object" &&
        event.payload !== null &&
        "type" in event.payload &&
        event.payload.type === "model_request_failed",
    ),
    false,
  );
  assert.deepEqual(
    f.warnings.filter((item) => item.message === "Native image receipt commit skipped"),
    [
      {
        message: "Native image receipt commit skipped",
        context: {
          event: "native_context.image_receipt.commit_skipped",
          module: "core.runtime",
          reason: "commit-failed",
        },
      },
    ],
  );
});
