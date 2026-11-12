import {
  type NativeContextConfiguration,
  type NativeContextObservation,
} from "@zcode/shared/native-context-compression";
import { getUpstreamRequestRecordCount } from "../conversation-session-network.js";
import { reloadElectronSessionPreservingBrowserProfile } from "../e2e-electron-reload.js";
import { installHandoffRpcProbe } from "../remote-project-handoff-probe.js";
import { selectV4TaskById, waitForV4ConversationState } from "../v4-conversation.js";
import { withNativeContextCleanup } from "./cleanup.js";
import { assertNativeContextTestPath } from "./environment.js";
import {
  getNativeContextStatus,
  listNativeContextObservations,
  listNativeContextRecords,
  readNativeContextImageChunk,
  readNativeContextOriginalImage,
  readNativeContextRecord,
  type NativeContextTestTarget,
} from "./queries.js";
import { closeNativeContextDetails, saveNativeContextConfiguration } from "./ui.js";
import type { NativeContextImageEvidence } from "./images.js";

export async function assertNativeContextBoundedReads(
  target: NativeContextTestTarget,
  evidence: NativeContextImageEvidence,
) {
  const beforeRequests = await getUpstreamRequestRecordCount();
  const status = await getNativeContextStatus(target);
  const complete = await listNativeContextObservations(target, status, { limit: 200 });
  const observations: NativeContextObservation[] = [];
  // 原因：账本按 sequence DESC 查询；首页 cursor=0 会排除所有真实记录。
  let cursor: number | undefined;
  for (let count = 0; count < 100; count += 1) {
    const page = await listNativeContextObservations(target, status, {
      ...(cursor === undefined ? {} : { cursor }),
      limit: 2,
    });
    expect(page.items.length).toBeLessThanOrEqual(2);
    expect([page.revision, page.generation, page.historyVersion]).toEqual([
      status.revision,
      status.generation,
      status.historyVersion,
    ]);
    observations.push(...page.items);
    if (page.nextCursor === null) break;
    expect(Number.isSafeInteger(page.nextCursor) && page.nextCursor > 0).toBe(true);
    if (cursor !== undefined) expect(page.nextCursor).toBeLessThan(cursor);
    cursor = page.nextCursor;
  }
  expect(observations).toEqual(complete.items);
  expect(new Set(observations.map((item) => item.id)).size).toBe(observations.length);
  const records = await listNativeContextRecords(target, status, { limit: 200 });
  const recordPage = await listNativeContextRecords(target, status, { limit: 1 });
  expect(recordPage.items).toEqual(records.items.slice(0, 1));
  const detail = await readNativeContextRecord(target, status, evidence.operationId, {
    sourceLimit: 100,
  });
  const sources = [];
  // 来源页仍是从零开始的 offset，不能借用 observation 的排他 sequence 游标。
  let sourceCursor = 0;
  for (let count = 0; count < 100; count += 1) {
    const page = await readNativeContextRecord(target, status, evidence.operationId, {
      sourceCursor,
      sourceLimit: 1,
      summaryLimitChars: 1,
    });
    expect(page.sources.length).toBeLessThanOrEqual(1);
    expect([page.revision, page.viewGeneration, page.viewHistoryVersion]).toEqual([
      status.revision,
      status.generation,
      status.historyVersion,
    ]);
    expect(page.sourceTotal).toBe(detail.sourceTotal);
    sources.push(...page.sources);
    if (page.nextSourceCursor === null) break;
    expect(page.nextSourceCursor).toBeGreaterThan(sourceCursor);
    sourceCursor = page.nextSourceCursor;
  }
  expect(sources).toEqual(detail.sources);
  expect(sources).toHaveLength(detail.sourceTotal);
  const original = await readNativeContextOriginalImage(target, status, evidence.originalRefs[0]!);
  expect(original.sha256).toBe(evidence.originalSha256);
  expect(original.bytes.length).toBe(evidence.sourceBytes);
  expect(await getUpstreamRequestRecordCount()).toBe(beforeRequests);
  expect((await getNativeContextStatus(target)).revision).toBe(status.revision);
}

/** 改策略使旧页真正过期；不能只用一个捏造的expectedRevision代替生命周期。 */
export async function assertNativeContextStaleView(
  target: NativeContextTestTarget,
  evidence: NativeContextImageEvidence,
) {
  const previous = await getNativeContextStatus(target);
  const configuration: NativeContextConfiguration = {
    schemaVersion: 1,
    mode: previous.policy.mode,
    parameters: structuredClone(previous.policy.parameters),
  };
  const changed = structuredClone(configuration);
  changed.parameters.images.cacheMaxEntries =
    changed.parameters.images.cacheMaxEntries === 17 ? 18 : 17;
  await withNativeContextCleanup(
    async () => {
      const next = await saveNativeContextConfiguration(changed);
      expect(next.revision).toBeGreaterThan(previous.revision);
      await expect(listNativeContextObservations(target, previous)).rejects.toThrow(
        /stale-view|revision/u,
      );
      await expect(
        readNativeContextImageChunk(target, previous, evidence.originalRefs[0]!),
      ).rejects.toThrow(/stale-view|revision/u);
      const original = await readNativeContextOriginalImage(
        target,
        next,
        evidence.originalRefs[0]!,
      );
      expect(original.sha256).toBe(evidence.originalSha256);
    },
    async () => {
      await saveNativeContextConfiguration(configuration);
    },
  );
}

export async function assertNativeContextForeignRef(
  otherTarget: NativeContextTestTarget,
  evidence: NativeContextImageEvidence,
) {
  expect(otherTarget.sessionId).not.toBe(evidence.target.sessionId);
  const status = await getNativeContextStatus(otherTarget);
  await expect(
    readNativeContextImageChunk(otherTarget, status, evidence.originalRefs[0]!),
  ).rejects.toThrow(/invalid-range|unknown-ref/u);
  await expect(readNativeContextRecord(otherTarget, status, evidence.operationId)).rejects.toThrow(
    /invalid-range|unknown-operation/u,
  );
}

/** 全套件唯一的冷重启；先确认Profile路径，再经过已有真实旧进程退出屏障。 */
export async function recoverNativeContextFromColdRestart(evidence: NativeContextImageEvidence) {
  await closeNativeContextDetails();
  await waitForV4ConversationState(
    (state) => state.state === "idle" && state.queueCount === 0,
    "NCTX cannot cold restart an unsettled execution",
  );
  const previous = await getNativeContextStatus(evidence.target);
  const observations = await listNativeContextObservations(evidence.target, previous, {
    limit: 200,
  });
  const beforeRequests = await getUpstreamRequestRecordCount();
  const profile = (await browser.electron.execute((electron) =>
    electron.app.getPath("userData"),
  )) as string;
  await assertNativeContextTestPath(profile);
  const actualProfile = await reloadElectronSessionPreservingBrowserProfile(browser);
  expect(await assertNativeContextTestPath(actualProfile)).toBe(profile);
  await selectV4TaskById(evidence.target.sessionId, 60000);
  await waitForV4ConversationState(
    (state) => state.state === "idle" && state.sessionId === evidence.target.sessionId,
    "NCTX did not recover the same owning session after cold restart",
    60000,
  );
  await installHandoffRpcProbe();
  const current = await getNativeContextStatus(evidence.target);
  expect(current.policy).toEqual(previous.policy);
  expect(current.generation).toBe(previous.generation);
  expect(current.lastObservation).toEqual(previous.lastObservation);
  expect([current.effectiveBlocks, current.referencedOutputs]).toEqual([
    previous.effectiveBlocks,
    previous.referencedOutputs,
  ]);
  expect(
    (await listNativeContextObservations(evidence.target, current, { limit: 200 })).items,
  ).toEqual(observations.items);
  const original = await readNativeContextOriginalImage(
    evidence.target,
    current,
    evidence.originalRefs[0]!,
  );
  expect(original.sha256).toBe(evidence.originalSha256);
  expect(original.bytes.length).toBe(evidence.sourceBytes);
  expect(await getUpstreamRequestRecordCount()).toBe(beforeRequests);
  return current;
}
