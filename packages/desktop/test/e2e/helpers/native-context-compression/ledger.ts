import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ServiceChannels } from "@zcode/shared";
import { formatModelPickerValue } from "@zcode/shared/model-selection";
import type { NativeContextObservation } from "@zcode/shared/native-context-compression";
import { DEFAULT_WORKSPACE } from "../desktop-app.js";
import { getUpstreamRequestRecordCount } from "../conversation-session-network.js";
import { resolveE2EHomeDir } from "../e2e-runtime-paths.js";
import { callHandoffHost, installHandoffRpcProbe } from "../remote-project-handoff-probe.js";
import { selectV4TaskById } from "../v4-conversation.js";
import { assertNativeContextTestPath } from "./environment.js";
import {
  assertNativeContextLedgerObservations,
  collectNativeContextLedgerPages,
} from "./ledger-assertions.js";
import {
  nativeContextLedgerManifestSchema,
  type NativeContextLedgerManifest,
} from "./ledger-fixture-contract.js";
import { verifyNativeContextLargeLedgerForE2E } from "./ledger-seed.js";
import {
  assertNativeContextLargeLedgerSelectedSvg,
  assertNativeContextLargeLedgerSvg,
  readNativeContextLargeLedgerSvg,
} from "./ledger-chart.js";
import {
  getNativeContextStatus,
  listNativeContextObservations,
  listNativeContextRecords,
  readNativeContextRecord,
} from "./queries.js";
import {
  chooseNativeContextOption,
  closeNativeContextDetails,
  nativeContextElement,
  openNativeContextDetails,
} from "./ui.js";

export async function readNativeContextLargeLedgerManifest(path: string) {
  return nativeContextLedgerManifestSchema.parse(
    JSON.parse(await readFile(await assertNativeContextTestPath(path), "utf8")),
  );
}

/** 只通过当前 Window Host 公共 resume 登记；seed 不抢任务组织态的唯一写者。 */
export async function openNativeContextLargeLedger(manifest: NativeContextLedgerManifest) {
  nativeContextLedgerManifestSchema.parse(manifest);
  for (const path of [
    manifest.sandboxRoot,
    manifest.homeDir,
    manifest.workspacePath,
    manifest.dbPath,
  ])
    await assertNativeContextTestPath(path);
  assert.equal(resolve(manifest.homeDir), resolve(resolveE2EHomeDir()));
  assert.equal(resolve(manifest.workspacePath), resolve(DEFAULT_WORKSPACE));
  assert.equal(
    resolve(manifest.dbPath),
    resolve(join(manifest.homeDir, ".zcodium", "cli", "db", "db.sqlite")),
  );
  if (process.env.ZCODE_SESSION_DB_PATH)
    assert.equal(resolve(manifest.dbPath), resolve(process.env.ZCODE_SESSION_DB_PATH));
  const requestsBefore = await getUpstreamRequestRecordCount();
  const seedProof = await verifyNativeContextLargeLedgerForE2E(manifest, "seed");
  if (!(await browser.execute(() => Boolean(window.__remoteProjectHandoffRpc?.ready))))
    await installHandoffRpcProbe();
  await closeNativeContextDetails();
  await callHandoffHost(ServiceChannels.ZCodeTask, "resumeTask", [
    {
      workspacePath: manifest.workspacePath,
      taskId: manifest.sessionId,
      // 单独 modelId 只满足 string 类型；resumeTask 还会按公开选择契约解析 Provider/模型。
      model: formatModelPickerValue({
        providerId: manifest.model.providerId,
        modelId: manifest.model.modelId,
      }),
    },
  ]);
  await selectV4TaskById(manifest.sessionId);
  const target = { workspacePath: manifest.workspacePath, sessionId: manifest.sessionId };
  const status = await getNativeContextStatus(target);
  const resumeProof = await verifyNativeContextLargeLedgerForE2E(manifest, "resume");
  assert.deepEqual(
    [status.revision, status.generation, status.historyVersion, status.currentSegmentId],
    [
      manifest.resumeExpected.revision,
      manifest.resumeExpected.generation,
      manifest.resumeExpected.historyVersion,
      manifest.resumeExpected.currentSegmentId,
    ],
  );
  assert.equal(status.policy.policyVersion, manifest.resumeExpected.policyVersion);
  assert.deepEqual(resumeProof.version, {
    revision: status.revision,
    generation: status.generation,
    historyVersion: status.historyVersion,
    policyVersion: status.policy.policyVersion,
    currentSegmentId: status.currentSegmentId,
  });
  assert.deepEqual(resumeProof.facts, seedProof.facts);
  assert.equal(status.policy.mode, "manual");
  assert.equal(await getUpstreamRequestRecordCount(), requestsBefore);
  return { target, status, requestsBefore };
}

export async function assertNativeContextLargeLedgerHostPages(
  manifest: NativeContextLedgerManifest,
) {
  const opened = await openNativeContextLargeLedger(manifest);
  const { target, status } = opened;
  // 原因：查询页属于已验证的恢复版本；页内旧观察与记录仍按种子事实逐项对账。
  const all = await collectNativeContextLedgerPages(
    manifest.resumeExpected,
    3000,
    (cursor, limit) => listNativeContextObservations(target, status, { cursor, limit }),
    (item) => item.id,
  );
  assertNativeContextLedgerObservations(manifest, all.items);
  for (const purpose of ["main", "maintenance", "decision"] as const) {
    const rows = await collectNativeContextLedgerPages(
      manifest.resumeExpected,
      manifest.counts[purpose],
      (cursor, limit) => listNativeContextObservations(target, status, { cursor, limit, purpose }),
      (item) => item.id,
    );
    assert.deepEqual(
      rows.items,
      all.items.filter((item) => item.purpose === purpose),
    );
  }
  const records = await collectNativeContextLedgerPages(
    manifest.resumeExpected,
    15,
    (cursor, limit) => listNativeContextRecords(target, status, { cursor, limit }),
    (item) => item.operationId,
    3,
  );
  assert.deepEqual([...records.items].reverse(), manifest.operations);
  for (const record of records.items) {
    const original = all.items.filter((item) => item.operationIds.includes(record.operationId));
    const rows = await collectNativeContextLedgerPages(
      manifest.resumeExpected,
      original.length,
      (cursor, limit) =>
        listNativeContextObservations(target, status, {
          cursor,
          limit,
          operationId: record.operationId,
        }),
      (item) => item.id,
    );
    assert.deepEqual(rows.items, original);
    const detail = await readNativeContextRecord(target, status, record.operationId);
    assert.equal(detail.sourceTotal, 4);
    assert.equal(detail.nextSourceCursor, null);
    assert.equal(detail.summary.length > 0, record.status === "completed");
  }
  return { ...opened, allPages: all.pages, allCursors: all.cursors, recordPages: records.pages };
}

async function selectOriginalPoint(original: NativeContextObservation) {
  await nativeContextElement("trend-request").click();
  const index = await browser.execute(
    (sequence) =>
      Array.from(document.querySelectorAll('[role="option"]')).findIndex((option) =>
        (option.textContent ?? "").trim().startsWith(`#${sequence} ·`),
      ),
    original.requestSeq,
  );
  assert.ok(index >= 0, "NCTX-58 original request is absent from its real selector");
  const option = (await $$('[role="option"]'))[index]!;
  await option.scrollIntoView();
  await option.click();
  await browser.waitUntil(
    async () =>
      (await nativeContextElement("request-details").getAttribute("data-observation-id")) ===
      original.id,
    { timeout: 10000, timeoutMsg: "NCTX-58 selected detail is not the original request" },
  );
  for (const [key, expected] of Object.entries({
    beforeEstimate: original.beforeEstimate,
    afterEstimate: original.afterEstimate,
    actualInput: original.actualInputTokens,
    cacheRead: original.cacheReadTokens,
    cacheCreate: original.cacheCreateTokens,
  })) {
    const text = await nativeContextElement("request-metric-" + key)
      .$("p.font-mono")
      .getText();
    assert.equal(
      expected === null ? text : Number(text.replace(/[,，\s]/gu, "")),
      expected === null ? "—" : expected,
    );
  }
  for (const chart of ["input-chart", "cache-chart", "image-chart"])
    assert.equal(
      await nativeContextElement(chart).getAttribute("data-selected-observation-id"),
      original.id,
    );
}

/** 调用者最后返回原短任务；此 helper 没有启动/重启任何 Host、CLI 或浏览器。 */
export async function assertNativeContextLargeLedgerProduct(manifest: NativeContextLedgerManifest) {
  const host = await assertNativeContextLargeLedgerHostPages(manifest);
  await openNativeContextDetails("trends");
  await chooseNativeContextOption("trend-segment", 0);
  await chooseNativeContextOption("trend-range", 2);
  await browser.waitUntil(
    async () =>
      Number(await nativeContextElement("input-chart").getAttribute("data-request-count")) === 200,
    { timeout: 20000, timeoutMsg: "NCTX-58 initial bounded page is absent" },
  );
  for (let loaded = 200; loaded < manifest.counts.main; ) {
    const expected = Math.min(loaded + 200, manifest.counts.main);
    await nativeContextElement("trends-load-more").waitForEnabled();
    await nativeContextElement("trends-load-more").click();
    await browser.waitUntil(
      async () =>
        Number(await nativeContextElement("input-chart").getAttribute("data-request-count")) ===
        expected,
      { timeout: 20000, timeoutMsg: "NCTX-58 long-range load did not advance one original page" },
    );
    loaded = expected;
  }
  assert.equal(await nativeContextElement("trends-load-more").isExisting(), false);
  for (const chart of ["input-chart", "cache-chart", "image-chart"])
    assert.equal(
      Number(await nativeContextElement(chart).getAttribute("data-request-count")),
      manifest.counts.main,
    );
  assert.equal(
    Number(await nativeContextElement("trends").getAttribute("data-maintenance-count")),
    30,
  );
  await chooseNativeContextOption("cache-unit", 0);
  const input = await browser.execute(readNativeContextLargeLedgerSvg, {
    chartId: "input-chart",
    series: "after",
  });
  const cache = await browser.execute(readNativeContextLargeLedgerSvg, {
    chartId: "cache-chart",
    series: "hit",
  });
  const svg = assertNativeContextLargeLedgerSvg(manifest, input, cache);
  await selectOriginalPoint(manifest.sentinels.selected);
  assertNativeContextLargeLedgerSelectedSvg(
    manifest,
    await browser.execute(readNativeContextLargeLedgerSvg, {
      chartId: "input-chart",
      series: "after",
    }),
  );
  for (const key of ["zero", "unknown", "increase", "event"] as const)
    await selectOriginalPoint(manifest.sentinels[key]);
  const final = await getNativeContextStatus(host.target);
  assert.deepEqual(
    [final.revision, final.generation, final.historyVersion],
    [host.status.revision, host.status.generation, host.status.historyVersion],
  );
  assert.equal(await getUpstreamRequestRecordCount(), host.requestsBefore);
  await verifyNativeContextLargeLedgerForE2E(manifest, "resume");
  await closeNativeContextDetails();
  return {
    allPages: host.allPages,
    allCursors: host.allCursors,
    recordPages: host.recordPages,
    ...svg,
  };
}
