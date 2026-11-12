import {
  TID_V4_FORK,
  TID_V4_TIMELINE,
  TID_V4_TIMELINE_BOTTOM,
  testId,
} from "@zcode/shared/test-ids";
import { getUpstreamRequestRecordCount } from "../conversation-session-network.js";
import {
  getV4Messages,
  scrollV4TimelineToTop,
  selectV4TaskById,
  waitForV4Pane,
} from "../v4-conversation.js";
import { withNativeContextCleanup } from "./cleanup.js";
import {
  getNativeContextStatus,
  listNativeContextObservations,
  listNativeContextRecords,
  nativeContextCurrentTarget,
  readNativeContextOriginalImage,
  readNativeContextRecord,
  type NativeContextTestTarget,
} from "./queries.js";
import { assertNativeContextForeignRef } from "./recovery.js";
import { closeNativeContextDetails } from "./ui.js";
import type { NativeContextImageEvidence } from "./images.js";

async function forkNativeContextRow(parent: NativeContextTestTarget, rowId: string) {
  const button = $(`[data-testid="${testId(TID_V4_FORK, rowId)}"]`);
  await button.waitForExist();
  // 轮尾工具栏由 assistant-turn hover 控制，已移出正文的 data-row-id。
  // 稳定 rowId 来自真实 projection；鼠标移入该按钮的占位触发所属轮次 hover，再验证可见与点击。
  await button.moveTo();
  await button.waitForDisplayed();
  await button.waitForEnabled();
  await button.click();
  await waitForV4Pane(
    (pane) => !!pane.sessionId && pane.sessionId !== "draft" && pane.sessionId !== parent.sessionId,
    "NCTX fork did not bind the child runtime",
    60000,
  );
  return nativeContextCurrentTarget();
}

export async function assertNativeContextOldFork(
  evidence: NativeContextImageEvidence,
  readonlyRowId: string,
  lastReadonlyRequestSeq: number,
) {
  await closeNativeContextDetails();
  const beforeRequests = await getUpstreamRequestRecordCount();
  const parent = await getNativeContextStatus(evidence.target);
  return withNativeContextCleanup(
    async () => {
      await scrollV4TimelineToTop();
      const childTarget = await forkNativeContextRow(evidence.target, readonlyRowId);
      const child = await getNativeContextStatus(childTarget);
      expect(child.policy).toEqual(parent.policy);
      const observations = await listNativeContextObservations(childTarget, child, { limit: 200 });
      expect(observations.items.length).toBeGreaterThan(0);
      expect(
        observations.items.every(
          (item) => item.origin === "inherited" && item.requestSeq <= lastReadonlyRequestSeq,
        ),
      ).toBe(true);
      expect(observations.items.some((item) => item.id === evidence.observation.id)).toBe(false);
      await assertNativeContextForeignRef(childTarget, evidence);
      expect(await getUpstreamRequestRecordCount()).toBe(beforeRequests);
      return childTarget;
    },
    async () => {
      await selectV4TaskById(evidence.target.sessionId);
    },
  );
}

export async function assertNativeContextLatestFork(evidence: NativeContextImageEvidence) {
  await closeNativeContextDetails();
  const bottom = $(`[data-testid="${TID_V4_TIMELINE_BOTTOM}"]`);
  if (await bottom.isDisplayed()) await bottom.click();
  // 原因：贴底点击先改变滚动意图，虚拟窗口到下一帧才挂载最新轮次。
  // 依据：data-index 对应 logical turn unit；确认末单元挂载后才读取真实稳定 rowId。
  await browser.waitUntil(
    () =>
      browser.execute((timelineId) => {
        const timeline = document.querySelector<HTMLElement>(`[data-testid="${timelineId}"]`);
        if (!timeline || timeline.getAttribute("data-following") !== "true") return false;
        const count = Number(timeline.getAttribute("data-render-unit-count"));
        if (!Number.isInteger(count) || count < 1) return false;
        const last = timeline.querySelector<HTMLElement>(
          `[data-v4-turn-unit="true"][data-index="${count - 1}"]`,
        );
        return (
          timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop <= 4 &&
          !!last &&
          Array.from(last.querySelectorAll<HTMLElement>("[data-row-id]")).some((row) =>
            row.classList.contains("group/assistant-row"),
          )
        );
      }, TID_V4_TIMELINE),
    { timeout: 15000, timeoutMsg: "NCTX latest logical turn did not mount at the real bottom" },
  );
  const beforeRequests = await getUpstreamRequestRecordCount();
  const parent = await getNativeContextStatus(evidence.target);
  const parentObservations = await listNativeContextObservations(evidence.target, parent, {
    limit: 200,
  });
  const parentRecord = await readNativeContextRecord(
    evidence.target,
    parent,
    evidence.operationId,
    { sourceLimit: 100 },
  );
  const rowId = (await getV4Messages("assistant")).at(-1)?.id;
  if (!rowId) throw new Error("NCTX latest stable response row is unavailable");
  return withNativeContextCleanup(
    async () => {
      const childTarget = await forkNativeContextRow(evidence.target, rowId);
      const child = await getNativeContextStatus(childTarget);
      expect(child.policy).toEqual(parent.policy);
      const observations = await listNativeContextObservations(childTarget, child, { limit: 200 });
      expect(observations.items).toHaveLength(parentObservations.items.length);
      expect(observations.items.every((item) => item.origin === "inherited")).toBe(true);
      const frozen = (items: typeof observations.items) =>
        items.map((item) => ({
          requestSeq: item.requestSeq,
          model: item.model,
          actualInputTokens: item.actualInputTokens,
          cacheReadTokens: item.cacheReadTokens,
          outputTokens: item.outputTokens,
          beforeEstimate: item.beforeEstimate,
          afterEstimate: item.afterEstimate,
        }));
      expect(frozen(observations.items)).toEqual(frozen(parentObservations.items));
      const records = await listNativeContextRecords(childTarget, child, { limit: 200 });
      const imageRecords = records.items.filter((item) => item.kind === "image");
      expect(imageRecords.length).toBeGreaterThan(0);
      let found = false;
      for (const record of imageRecords) {
        expect(record.origin).toBe("inherited");
        const detail = await readNativeContextRecord(childTarget, child, record.operationId, {
          sourceLimit: 100,
        });
        for (const source of detail.sources.filter((item) => item.kind === "image")) {
          expect(source.originalAvailable).toBe(true);
          expect(
            parentRecord.sources.some(
              (item) => item.partId === source.partId || item.messageId === source.messageId,
            ),
          ).toBe(false);
          const original = await readNativeContextOriginalImage(childTarget, child, source.ref);
          if (original.sha256 === evidence.originalSha256) found = true;
        }
      }
      expect(found).toBe(true);
      expect(await getUpstreamRequestRecordCount()).toBe(beforeRequests);
      return childTarget;
    },
    async () => {
      await selectV4TaskById(evidence.target.sessionId);
    },
  );
}
