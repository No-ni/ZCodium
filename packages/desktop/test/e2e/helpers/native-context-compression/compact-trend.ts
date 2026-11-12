import {
  getUpstreamRequestEvidence,
  getUpstreamRequestRecordCount,
} from "../conversation-session-network.js";
import { waitForV4CompactMarker, waitForV4ConversationState } from "../v4-conversation.js";
import {
  getNativeContextStatus,
  listNativeContextObservations,
  listNativeContextRecords,
  nativeContextCurrentTarget,
} from "./queries.js";
import {
  chooseNativeContextOption,
  closeNativeContextDetails,
  nativeContextElement,
  openNativeContextDetails,
} from "./ui.js";

/** 冷恢复验收后独立执行：真实 compact 会改变历史，不能混入只读趋势场景。 */
export async function assertNativeContextCompactCurrentSegment() {
  const target = await nativeContextCurrentTarget();
  const before = await getNativeContextStatus(target);
  const oldRecords = await listNativeContextRecords(target, before, {
    limit: 200,
  });
  expect(oldRecords.items.some((record) => record.segmentId === before.currentSegmentId)).toBe(
    true,
  );
  // 原因：afterIndex 排除自身，count - 1 才会包含本次 compact 的首个真实请求。
  const requestIndex = (await getUpstreamRequestRecordCount()) - 1;
  await closeNativeContextDetails();
  await nativeContextElement("entry").click();
  await nativeContextElement("deep-compact").waitForEnabled();
  await nativeContextElement("deep-compact").click();
  await waitForV4CompactMarker({ status: "success", origin: "manual" });
  await waitForV4ConversationState(
    (state) => state.state === "idle" && state.queueCount === 0,
    "NCTX real deep compact did not finish through the existing FIFO",
    90000,
  );
  let status = before;
  await browser.waitUntil(
    async () => {
      status = await getNativeContextStatus(target);
      return (
        status.phase === "idle" &&
        status.currentSegmentId !== before.currentSegmentId &&
        status.lastOperation?.kind === "compact-boundary" &&
        status.lastOperation.segmentId === status.currentSegmentId &&
        status.lastOperation.status === "completed"
      );
    },
    {
      timeout: 20000,
      timeoutMsg: "NCTX owner did not publish the committed current compact segment",
    },
  );
  expect(status.revision).toBeGreaterThan(before.revision);
  expect(status.policy).toEqual(before.policy);
  const [main, maintenance, decisions, records] = await Promise.all([
    listNativeContextObservations(target, status, {
      purpose: "main",
      segmentId: status.currentSegmentId,
      limit: 200,
    }),
    listNativeContextObservations(target, status, {
      purpose: "maintenance",
      segmentId: status.currentSegmentId,
      limit: 200,
    }),
    listNativeContextObservations(target, status, {
      purpose: "decision",
      segmentId: status.currentSegmentId,
      limit: 200,
    }),
    listNativeContextRecords(target, status, { limit: 200 }),
  ]);
  expect(main.items).toHaveLength(0);
  expect(main.nextCursor).toBe(null);
  expect(maintenance.items).toHaveLength(0);
  expect(decisions.items).toHaveLength(0);
  const currentOperation = records.items.find(
    (operation) =>
      operation.kind === "compact-boundary" && operation.segmentId === status.currentSegmentId,
  );
  expect(currentOperation).toBeDefined();
  expect(currentOperation!.operationId).toBe(status.lastOperation!.operationId);
  let requests = await getUpstreamRequestEvidence(
    { includes: ["CRITICAL: Respond with TEXT ONLY", "E2E_NCTX"] },
    { afterIndex: requestIndex },
  );
  await browser.waitUntil(
    async () => {
      requests = await getUpstreamRequestEvidence(
        { includes: ["CRITICAL: Respond with TEXT ONLY", "E2E_NCTX"] },
        { afterIndex: requestIndex },
      );
      return requests.some(
        (request) => request.fixtureId === "native-deep-compact" && request.status === "complete",
      );
    },
    { timeout: 20000, timeoutMsg: "NCTX deep compact request capture did not settle" },
  );
  expect(requests).toHaveLength(1);
  expect(requests[0]!.fixtureId).toBe("native-deep-compact");
  expect(requests[0]!.status).toBe("complete");

  await openNativeContextDetails("trends");
  await chooseNativeContextOption("trend-segment", 0);
  await chooseNativeContextOption("trend-range", 0);
  const trend = nativeContextElement("trends");
  // 原因：旧段最后主请求仍存在，空态必须等新 owner 段查询完成，不能只等图表消失。
  await browser.waitUntil(
    async () =>
      (await trend.getAttribute("data-current-segment-id")) === status.currentSegmentId &&
      (await trend.getAttribute("data-active-segment-id")) === status.currentSegmentId &&
      (await trend.getAttribute("data-loading")) === "false" &&
      (await trend.getAttribute("data-failed")) === "false",
    {
      timeout: 20000,
      timeoutMsg: "NCTX trends did not select the actual owner compact segment",
    },
  );
  expect(await nativeContextElement("trend-empty").isDisplayed()).toBe(true);
  expect(await nativeContextElement("input-chart").isExisting()).toBe(false);
  expect(await nativeContextElement("cache-chart").isExisting()).toBe(false);
  expect(await nativeContextElement("image-chart").isExisting()).toBe(false);
  expect(await trend.getAttribute("data-maintenance-count")).toBe("0");
  expect(await nativeContextElement("event-" + currentOperation!.operationId).isDisplayed()).toBe(
    true,
  );
  for (const operation of oldRecords.items) {
    expect(await nativeContextElement("event-" + operation.operationId).isExisting()).toBe(false);
  }
  await expect(listNativeContextObservations(target, before)).rejects.toThrow(
    /stale-view|revision/u,
  );
  const readonlyIndex = await getUpstreamRequestRecordCount();
  await nativeContextElement("tab-overview").click();
  const recent = nativeContextElement("recent-trend-overview");
  await browser.waitUntil(
    async () =>
      (await recent.getAttribute("data-current-segment-id")) === status.currentSegmentId &&
      (await recent.getAttribute("data-loading")) === "false",
    {
      timeout: 20000,
      timeoutMsg: "NCTX overview short tail retained the pre-compact main segment",
    },
  );
  expect(await recent.getAttribute("data-request-count")).toBe("0");
  expect(await recent.$(".recharts-line-curve").isExisting()).toBe(false);
  expect(await getUpstreamRequestRecordCount()).toBe(readonlyIndex);
  await closeNativeContextDetails();
  return status;
}
