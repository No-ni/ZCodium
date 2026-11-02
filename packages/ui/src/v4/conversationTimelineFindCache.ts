// 会话查找的 unit 命中缓存与搜索片段归一（spec：docs/specs/performance-round11-find.md）。
// 从 useConversationTimelineFind.ts 拆出：UnitFindCache 与 lookups/nextCache 仍由 hook 的 ref 与
// useMemo 拥有，这里只按传入的同一份 Map 读写；缓存失效判定、命中追加顺序与
// loadedRowCount 求和逐字不变，不新建缓存、不持有状态。
import type { ConversationFindMatch } from "@/v4/conversationFindIndex.js";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";

export function normalizeSearchResultSnippet(text: string): string {
  return text
    .replace(/^\.{3}/, "")
    .replace(/\.{3}$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function sourceTextContainsSnippet(sourceText: string, snippet: string): boolean {
  const normalizedSnippet = normalizeSearchResultSnippet(snippet).toLocaleLowerCase();
  if (!normalizedSnippet) {
    return false;
  }
  return normalizeSearchResultSnippet(sourceText).toLocaleLowerCase().includes(normalizedSnippet);
}

export type UnitFindCache = Map<
  string,
  { unit: ConversationTurnRenderUnit; source: ConversationFindMatch[]; loadedRowCount: number }
>;

/**
 * 把一段 unit 的命中按全局顺序追加到 matches，返回这些 unit 的 loadedRowCount 之和。
 * 修复原因：streaming delta 只会改变当前 running turn；稳定 turn 的全文索引可复用，
 * 避免每个 token 都扫描整段历史，导致长会话 renderer 主线程被持续占满。
 * 不在运行的 unit 依次在 lookups 里找上一份命中并写入 nextCache；运行中的 unit 每次重建。
 */
export function appendUnitFindMatches({
  units,
  indexOffset,
  matches,
  cacheKeyPrefix,
  lookups,
  nextCache,
  build,
}: {
  units: readonly ConversationTurnRenderUnit[];
  indexOffset: number;
  matches: ConversationFindMatch[];
  cacheKeyPrefix: string;
  lookups: readonly UnitFindCache[];
  nextCache: UnitFindCache;
  build: (unit: ConversationTurnRenderUnit) => {
    matches: ConversationFindMatch[];
    loadedRowCount: number;
  };
}): number {
  let loadedRowCount = 0;
  units.forEach((unit, offset) => {
    const unitIndex = indexOffset + offset;
    const cacheKey = `${cacheKeyPrefix}:${unit.key}`;
    // 历史修订保留 turn key，但正文已改变；缓存必须跟随不可变投影身份失效。
    const cached = unit.isRunning
      ? undefined
      : lookups.map((cache) => cache.get(cacheKey)).find((entry) => entry?.unit === unit);
    const unitIndexResult = cached
      ? { matches: cached.source, loadedRowCount: cached.loadedRowCount }
      : build(unit);
    if (!unit.isRunning) {
      nextCache.set(
        cacheKey,
        cached ?? {
          unit,
          source: unitIndexResult.matches,
          loadedRowCount: unitIndexResult.loadedRowCount,
        },
      );
    }
    loadedRowCount += unitIndexResult.loadedRowCount;
    for (const match of unitIndexResult.matches) {
      // 新构建的命中尚未发布，直接补全位置；缓存命中只在窗口位置变化时复制。
      // 高频短查询可产生大量结果，不能在同一轮构建后再无条件复制全部对象。
      if (!cached) {
        match.globalIndex = matches.length;
        match.unitIndex = unitIndex;
      }
      matches.push(
        match.globalIndex === matches.length && match.unitIndex === unitIndex
          ? match
          : { ...match, globalIndex: matches.length, unitIndex },
      );
    }
  });
  return loadedRowCount;
}

/** 沿原数组按活动索引读取，负索引和越界保持同一空命中语义。 */
export function getFindMatch(
  matches: readonly ConversationFindMatch[],
  index: number,
): ConversationFindMatch | null {
  return index >= 0 ? (matches[index] ?? null) : null;
}
