import assert from "node:assert/strict";
import {
  emptyNativeContextImageMeasurement,
  type NativeContextObservation,
  type NativeContextPage,
} from "@zcode/shared/native-context-compression";
import type { NativeContextLedgerManifest } from "./ledger-fixture-contract.js";

export async function collectNativeContextLedgerPages<T>(
  version: Pick<NativeContextPage<unknown>, "revision" | "generation" | "historyVersion">,
  expectedCount: number,
  readPage: (cursor: number | undefined, limit: number) => Promise<NativeContextPage<T>>,
  identity: (item: T) => string,
  limit = 200,
) {
  const items: T[] = [];
  const cursors: number[] = [];
  const seen = new Set<string>();
  let cursor: number | undefined;
  let terminalCursor: number | null | undefined;
  const maximumPages = Math.max(1, Math.ceil(expectedCount / limit));
  for (let pageIndex = 0; pageIndex < maximumPages; pageIndex++) {
    const page = await readPage(cursor, limit);
    assert.deepEqual(
      [page.revision, page.generation, page.historyVersion],
      [version.revision, version.generation, version.historyVersion],
    );
    assert.ok(page.items.length <= limit);
    for (const item of page.items) {
      const id = identity(item);
      assert.ok(!seen.has(id), "NCTX-58 pagination duplicated an original record");
      seen.add(id);
      items.push(item);
    }
    terminalCursor = page.nextCursor;
    if (terminalCursor === null) break;
    assert.equal(page.items.length, limit, "NCTX-58 nonterminal pages must be complete");
    assert.ok(Number.isSafeInteger(terminalCursor) && terminalCursor > 0);
    // 当前 SessionStore 从 sequence desc 读旧记录；不能沿用旧 fixture 的 offset/cursor=0。
    if (cursor !== undefined)
      assert.ok(terminalCursor < cursor, "NCTX-58 cursor must move to older rows");
    cursors.push(terminalCursor);
    cursor = terminalCursor;
  }
  assert.equal(terminalCursor, null, "NCTX-58 pagination must reach its real terminal cursor");
  assert.equal(items.length, expectedCount);
  return { items, cursors, pages: cursors.length + 1, terminalCursor };
}

export function assertNativeContextLedgerObservations(
  manifest: NativeContextLedgerManifest,
  observations: readonly NativeContextObservation[],
) {
  assert.equal(observations.length, manifest.counts.observations);
  assert.equal(new Set(observations.map((item) => item.id)).size, observations.length);
  assert.equal(
    new Set(
      observations.map((item) => `${item.purpose}:${item.logicalRequestId}:${item.attemptIndex}`),
    ).size,
    observations.length,
    "NCTX-58 duplicate physical attempt",
  );
  for (const purpose of ["main", "maintenance", "decision"] as const)
    assert.equal(
      observations.filter((item) => item.purpose === purpose).length,
      manifest.counts[purpose],
    );
  const byId = new Map(observations.map((item) => [item.id, item]));
  for (const sentinel of Object.values(manifest.sentinels))
    assert.deepEqual(byId.get(sentinel.id), sentinel);
  const main = observations.filter((item) => item.purpose === "main");
  assert.equal(new Set(main.map((item) => item.requestSeq)).size, manifest.counts.main);
  assert.equal(Math.max(...main.map((item) => item.beforeEstimate ?? -1)), 195000);
  assert.equal(Math.max(...main.map((item) => item.afterEstimate ?? -1)), 190000);
  assert.equal(Math.max(...main.map((item) => item.actualInputTokens ?? -1)), 185000);
  assert.equal(
    Math.min(...main.flatMap((item) => (item.afterEstimate === null ? [] : [item.afterEstimate]))),
    0,
  );
  assert.equal(
    manifest.sentinels.increase.beforeEstimate! - manifest.sentinels.increase.afterEstimate!,
    -1000,
  );
  let unknown = 0;
  for (const item of observations) {
    assert.equal(item.usageRecordRef, item.id);
    const querySource = item.purpose === "main" ? "main_turn" : `native_context_${item.purpose}`;
    assert.equal(
      item.id,
      `usage_model_${querySource}_${item.logicalRequestId}_${item.attemptIndex}`,
    );
    assert.equal(
      item.anchorMessageId,
      manifest.sentinels.first.anchorMessageId!.replace(/-1$/u, `-${item.requestSeq}`),
    );
    assert.deepEqual(item.images, emptyNativeContextImageMeasurement());
    assert.equal(item.visionTokens, null);
    if (item.purpose !== "main") continue;
    const inGap = manifest.unknownGaps.some(
      (gap) => item.requestSeq >= gap.first && item.requestSeq <= gap.last,
    );
    if (inGap) {
      unknown += 1;
      assert.deepEqual(
        [item.actualInputTokens, item.outputTokens, item.cacheReadTokens, item.cacheCreateTokens],
        [null, null, null, null],
      );
      assert.ok(item.beforeEstimate !== null && item.afterEstimate !== null);
    } else assert.ok(item.actualInputTokens !== null);
  }
  assert.equal(unknown, 62);
  assert.deepEqual(
    [
      manifest.sentinels.zero.afterEstimate,
      manifest.sentinels.zero.actualInputTokens,
      manifest.sentinels.zero.cacheReadTokens,
      manifest.sentinels.zero.cacheCreateTokens,
    ],
    [0, 0, 0, 0],
  );
  return { observations: observations.length, main: main.length, unknownMain: unknown };
}
