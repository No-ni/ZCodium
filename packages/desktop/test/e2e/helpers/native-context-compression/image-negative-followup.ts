import { createHash } from "node:crypto";
import { ServiceChannels } from "@zcode/shared";
import { TID_CHAT_ERROR_BANNER } from "@zcode/shared/test-ids";
import { v4ConversationRowsRangeResultSchema } from "@zcode/shared/zcode-protocol-v4";
import {
  getUpstreamRequestEvidence,
  getUpstreamRequestRecordCount,
} from "../conversation-session-network.js";
import { callHandoffHost } from "../remote-project-handoff-probe.js";
import {
  getV4ComposerText,
  sendV4Prompt,
  setV4ComposerText,
  waitForV4ConversationState,
} from "../v4-conversation.js";
import { withNativeContextCleanup } from "./cleanup.js";
import { readNativeContextComposerModel } from "./model.js";
import type { NativeContextImageNegativeEvidence } from "./image-negative.js";
import { nativeContextWireImages } from "./images.js";
import {
  getNativeContextStatus,
  listNativeContextObservations,
  listNativeContextRecords,
  nativeContextCurrentTarget,
  readNativeContextOriginalImage,
  readNativeContextRecord,
  type NativeContextTestTarget,
} from "./queries.js";
import { NATIVE_CONTEXT_IMAGE_NEGATIVE_RECOVERY } from "./replay-image-negative.js";

async function rows(target: NativeContextTestTarget) {
  return v4ConversationRowsRangeResultSchema.parse(
    await callHandoffHost(ServiceChannels.ZCodeAgent, "conversationRowsRangeV4", [
      { ...target, limit: 200, residency: "resident-only" },
    ]),
  ).rows;
}

export interface NativeContextImageFollowupEvidence {
  kind: NativeContextImageNegativeEvidence["kind"];
  availability: "usable" | "poisoned" | "failed-after-request";
  inputRowId: number;
  turnId: string;
  turnState: string;
  providerFixtureIds: Array<string | null>;
  errorCode: string | null;
  oldToolPartRetained: boolean;
  originalUnchanged: boolean;
}

export class NativeContextImageFollowupError extends Error {
  constructor(readonly evidence: NativeContextImageFollowupEvidence) {
    // 新user行与真实终态证明第二轮失败，不能用旧banner或idle过渡态冒充poisoning。
    super(
      `NCTX33_IMAGE_FAILURE_${evidence.availability.toUpperCase()} kind=${evidence.kind}; ` +
        `newTurn=${evidence.turnState}; providerRequests=${evidence.providerFixtureIds.length}; ` +
        `oldToolPartRetained=${evidence.oldToolPartRetained}; originalUnchanged=${evidence.originalUnchanged}; ` +
        `errorCode=${evidence.errorCode ?? "none"}`,
    );
    this.name = "NativeContextImageFollowupError";
  }
}

/** 真新prompt复用失败owner；不rewind、不清intent、不删除已经成功读取的ToolPart。 */
export async function assertNativeContextImageFailureFollowup(
  negative: NativeContextImageNegativeEvidence,
): Promise<NativeContextImageFollowupEvidence> {
  const target = await nativeContextCurrentTarget();
  expect(target).toEqual(negative.target);
  const draft = (await getV4ComposerText()) ?? "";
  return withNativeContextCleanup(
    async () => {
      await waitForV4ConversationState(
        (state) =>
          state.sessionId === target.sessionId && state.state === "idle" && state.queueCount === 0,
        "NCTX image recovery requires the same failed and settled existing owner",
      );
      const before = await getNativeContextStatus(target);
      const previousObservations = await listNativeContextObservations(target, before, {
        limit: 200,
      });
      const previousRecords = await listNativeContextRecords(target, before, { limit: 200 });
      if (previousObservations.nextCursor !== null || previousRecords.nextCursor !== null)
        throw new Error("NCTX image recovery requires a complete short ledger");
      const priorRows = await rows(target);
      const oldTool = priorRows.find((row) => row.rowId === negative.toolRowId);
      if (oldTool?.kind !== "toolCall" || oldTool.toolCallId !== negative.toolCallId)
        throw new Error("NCTX image recovery lost the actual old ToolPart before submit");
      const rowWatermark = Math.max(0, ...priorRows.map((row) => row.rowId));
      const model = await readNativeContextComposerModel(target);
      const fixture = NATIVE_CONTEXT_IMAGE_NEGATIVE_RECOVERY[negative.kind];
      const afterIndex = (await getUpstreamRequestRecordCount()) - 1;
      await sendV4Prompt(
        `${fixture.marker}: Reply upstream-e2e-ok to this new text prompt. Call no tools.`,
      );
      let currentRows = priorRows;
      await browser.waitUntil(
        async () => {
          currentRows = await rows(target);
          const input = currentRows.findLast(
            (row) =>
              row.kind === "userInput" &&
              row.rowId > rowWatermark &&
              row.text.includes(fixture.marker + ":"),
          );
          return Boolean(
            input &&
            currentRows.some(
              (row) =>
                row.kind === "turnHeader" && row.turnId === input.turnId && row.state !== "running",
            ),
          );
        },
        {
          timeout: 90000,
          timeoutMsg: "NCTX image recovery new user turn has no authoritative terminal state",
        },
      );
      const input = currentRows.findLast(
        (row) =>
          row.kind === "userInput" &&
          row.rowId > rowWatermark &&
          row.text.includes(fixture.marker + ":"),
      );
      const turn = currentRows.find(
        (row) => row.kind === "turnHeader" && row.turnId === input?.turnId,
      );
      if (input?.kind !== "userInput" || turn?.kind !== "turnHeader")
        throw new Error("NCTX image recovery terminal has no matching new input and turn");
      expect(turn.turnId).not.toBe(oldTool.turnId);
      await waitForV4ConversationState(
        (state) =>
          state.sessionId === target.sessionId && state.state === "idle" && state.queueCount === 0,
        "NCTX image recovery did not settle on the same owner",
      );
      let requests = await getUpstreamRequestEvidence({}, { afterIndex });
      const after = await getNativeContextStatus(target);
      const currentObservations = await listNativeContextObservations(target, after, {
        limit: 200,
      });
      const currentRecords = await listNativeContextRecords(target, after, { limit: 200 });
      expect(currentObservations.nextCursor).toBeNull();
      expect(currentRecords.nextCursor).toBeNull();
      expect(after.policy).toEqual(before.policy);
      expect(after.generation).toBe(before.generation);
      expect(after.currentSegmentId).toBe(before.currentSegmentId);
      expect(after.effectiveBlocks).toBe(before.effectiveBlocks);
      const oldIds = new Set(previousObservations.items.map((item) => item.id));
      for (const old of previousObservations.items)
        expect(currentObservations.items.find((item) => item.id === old.id)).toEqual(old);
      const newObservations = currentObservations.items.filter((item) => !oldIds.has(item.id));
      const oldOperations = new Set(previousRecords.items.map((item) => item.operationId));
      const newRecords = currentRecords.items.filter(
        (item) => !oldOperations.has(item.operationId),
      );
      expect(
        newRecords.filter((item) => ["summary", "decision", "restore-image"].includes(item.kind)),
      ).toHaveLength(0);
      const oldRestore = await readNativeContextRecord(target, after, negative.operationId, {
        sourceLimit: 100,
      });
      expect(oldRestore.status).toBe("completed");
      expect(oldRestore.observationIds).toHaveLength(0);
      expect(
        oldRestore.sources.some(
          (source) => source.ref === negative.originalRef && source.originalAvailable,
        ),
      ).toBe(true);
      const stored = await readNativeContextOriginalImage(target, after, negative.originalRef);
      const originalUnchanged =
        stored.bytes.length === negative.originalBytes &&
        createHash("sha256").update(stored.bytes).digest("hex") === negative.originalSha256;
      expect(originalUnchanged).toBe(true);
      const retained = currentRows.find((row) => row.rowId === negative.toolRowId);
      const oldToolPartRetained =
        retained?.kind === "toolCall" &&
        retained.toolCallId === oldTool.toolCallId &&
        retained.turnId === oldTool.turnId &&
        retained.status === "success" &&
        retained.inputText === oldTool.inputText;
      expect(oldToolPartRetained).toBe(true);
      const banner = $(`[data-testid="${TID_CHAT_ERROR_BANNER}"]`);
      const errorCode = (await banner.isDisplayed())
        ? await banner.getAttribute("data-error-code")
        : null;
      const evidence: NativeContextImageFollowupEvidence = {
        kind: negative.kind,
        availability:
          turn.state === "completedSuccess"
            ? "usable"
            : requests.length
              ? "failed-after-request"
              : "poisoned",
        inputRowId: input.rowId,
        turnId: input.turnId,
        turnState: turn.state,
        providerFixtureIds: requests.map((request) => request.fixtureId),
        errorCode,
        oldToolPartRetained,
        originalUnchanged,
      };
      // Provider前失败立即给结构化证据，不反复等待fixture，不在测试中修复坏owner。
      if (evidence.availability !== "usable") {
        if (evidence.availability === "poisoned")
          expect(
            newObservations.every((item) => item.purpose === "main" && item.status !== "completed"),
          ).toBe(true);
        throw new NativeContextImageFollowupError(evidence);
      }
      // turn 终态可先于 replay 串行 writer 落盘；等待同一 capture 的终态，不能重发 prompt 或筛掉异常请求。
      await browser.waitUntil(
        async () => {
          requests = await getUpstreamRequestEvidence({}, { afterIndex });
          return requests.length > 0 && requests.every((request) => request.status !== "pending");
        },
        {
          timeout: 30000,
          timeoutMsg: "NCTX image recovery capture did not reach a durable terminal state",
        },
      );
      evidence.providerFixtureIds = requests.map((request) => request.fixtureId);
      expect(requests.map((request) => request.fixtureId)).toEqual([fixture.fixtureId]);
      expect(requests[0]!.status).toBe("complete");
      expect(requests[0]!.statusCode).toBe(200);
      expect((requests[0]!.requestJson as { model?: string }).model).toBe(model.modelId);
      expect(newObservations).toHaveLength(1);
      const observation = newObservations[0]!;
      expect(observation.purpose).toBe("main");
      expect(observation.status).toBe("completed");
      expect(observation.actualInputTokens).toBe(fixture.inputTokens);
      expect(observation.model).toEqual({ providerId: model.providerId, modelId: model.modelId });
      const wire = nativeContextWireImages(requests[0]!.requestJson);
      const exact = wire.filter(
        (image) =>
          createHash("sha256").update(image.bytes).digest("hex") === negative.originalSha256,
      );
      // 真实新输入不继承失败轮的原图豁免；相同 bytes 的多个历史 part 仍各有独立身份，不能全请求按 hash 计一次。
      expect(observation.images.restoredCount).toBe(0);
      if (negative.kind === "capacity") {
        expect(exact).toHaveLength(0);
      }
      expect(observation.images.sentCount).toBe(wire.length);
      return evidence;
    },
    () => setV4ComposerText(draft),
  );
}
