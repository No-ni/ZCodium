import {
  sameItems,
  type ConversationTurnRenderUnit,
  type ConversationTurnRenderUnitsPartition,
} from "@/v4/conversationTurnRenderUnits.js";
import type { ConversationTurnNavigatorCache } from "./conversationTurnNavigatorCache.js";
import type {
  BuildConversationTurnNavigatorItemsOptions,
  ConversationTurnNavigatorAssistantPreviewKind,
  ConversationTurnNavigatorItem,
} from "./conversationTurnNavigatorTypes.js";
// 公开类型已拆到 conversationTurnNavigatorTypes.ts，滚动定位函数已拆到
// conversationTurnNavigatorPosition.ts；这里按原入口重新导出，外部从本模块
// 导入类型与函数的路径和符号保持不变。
export {
  resolveConversationTurnNavigatorActiveQueryRowId,
  resolveConversationTurnNavigatorActiveUnitIndex,
  resolveConversationTurnNavigatorBarVisualState,
  resolveConversationTurnNavigatorVisualFocusItemIndex,
} from "./conversationTurnNavigatorPosition.js";
export type * from "./conversationTurnNavigatorTypes.js";

export const CONVERSATION_TURN_NAVIGATOR_MIN_WIDTH_PX = 864;

function collectRealUserQueryRowIds(units: readonly ConversationTurnRenderUnit[]): number[] {
  const rowIds: number[] = [];
  for (const unit of units) {
    for (const row of unit.visibleUserInputs) {
      if (row.origin === "realUser") rowIds.push(row.rowId);
    }
  }
  return rowIds;
}

/**
 * 目录成员未变时保持身份；正文 token/时钟不能让 DOM 锚点登记跟着全量重建。
 * 输入按「历史 + 尾轮」分区（docs/ui/chat-virtual-scroll.md「每帧派生成本」）：历史段引用不变且
 * 尾轮成员不变时直接复用，流式帧只收集尾轮；历史段变化时才整窗比较成员。
 */
export function createConversationTurnNavigatorQueryRowIdsSelector() {
  let previous: ReadonlySet<number> = new Set<number>();
  let previousHistory: readonly ConversationTurnRenderUnit[] | null = null;
  let previousTailRowIds: number[] = [];
  return (units: ConversationTurnRenderUnitsPartition): ReadonlySet<number> => {
    const tailRowIds = collectRealUserQueryRowIds(units.tail);
    if (previousHistory === units.history && sameItems(previousTailRowIds, tailRowIds)) {
      return previous;
    }
    previousHistory = units.history;
    previousTailRowIds = tailRowIds;
    const next = new Set([...collectRealUserQueryRowIds(units.history), ...tailRowIds]);
    if (next.size !== previous.size || [...next].some((rowId) => !previous.has(rowId))) {
      previous = next;
    }
    return previous;
  };
}

export type ConversationTurnNavigatorHydrationResult =
  | { status: "unsupported"; logEpoch: string }
  | { status: "hydrated"; logEpoch: string }
  | { status: "not-enough-queries"; logEpoch: string }
  | { status: "retryable-failure"; logEpoch: string }
  | { status: "stale"; logEpoch: string };

export function shouldHydrateConversationTurnNavigatorDirectory(params: {
  canLoadOlder: boolean;
  containerWidthPx: number;
  hasLoadHandler: boolean;
  loadingOlder: boolean;
}): boolean {
  return (
    params.canLoadOlder &&
    !params.loadingOlder &&
    params.hasLoadHandler &&
    params.containerWidthPx >= CONVERSATION_TURN_NAVIGATOR_MIN_WIDTH_PX
  );
}

export function resolveConversationTurnNavigatorHydrationRetryDelayMs(
  failedAttemptCount: number,
): number | null {
  if (failedAttemptCount === 1) return 250;
  if (failedAttemptCount === 2) return 1_000;
  return null;
}

const DEFAULT_MAX_PREVIEW_CHARS = 220;
const DEFAULT_MAX_PREVIEW_PARAGRAPHS = 2;

function truncatePreview(text: string, maxChars: number): string {
  const normalizedMaxChars = Math.max(8, maxChars);
  if (text.length <= normalizedMaxChars) {
    return text;
  }
  return `${text.slice(0, normalizedMaxChars - 3).trimEnd()}...`;
}

function buildPreviewText({
  texts,
  fallback,
  maxPreviewChars,
  maxPreviewParagraphs,
}: {
  texts: Iterable<string>;
  fallback: string;
  maxPreviewChars: number;
  maxPreviewParagraphs: number;
}): string {
  const maxChars = Math.max(8, maxPreviewChars);
  const maxParagraphs = Math.trunc(Math.max(1, maxPreviewParagraphs));
  let preview = "";
  let paragraphs = 1;
  let whitespace = false;
  let newlines = 0;
  // 旧实现先拼接并正则处理整份正文，最后才截断；每个流式 delta 都会重扫长历史。
  // 多读一个有效字符即可判断是否省略，保留原来的空白、空行分段及 UTF-16 截断语义。
  for (const text of texts) {
    if (preview) {
      whitespace = true;
      newlines = 2;
    }
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index]!;
      if (/\s/u.test(character)) {
        whitespace = true;
        if (character === "\n") newlines += 1;
        continue;
      }
      if (whitespace && preview) {
        if (newlines >= 2) {
          if (paragraphs >= maxParagraphs) return truncatePreview(preview, maxChars);
          paragraphs += 1;
          preview += "\n";
        } else {
          preview += " ";
        }
      }
      preview += character;
      whitespace = false;
      newlines = 0;
      if (preview.length > maxChars) return truncatePreview(preview, maxChars);
    }
  }
  return preview || fallback;
}

function buildRowsPreview(
  rows: readonly { text: string }[],
  fallback: string,
  options: Required<BuildConversationTurnNavigatorItemsOptions>,
  cache?: ConversationTurnNavigatorCache,
): string {
  const create = (texts: Iterable<string>) => buildPreviewText({ texts, fallback, ...options });
  if (cache) return cache.preview(rows, fallback, options, create);
  function* texts() {
    for (const row of rows) yield row.text;
  }
  return create(texts());
}

function buildAssistantPreview(
  unit: ConversationTurnRenderUnit,
  options: Required<BuildConversationTurnNavigatorItemsOptions>,
  cache?: ConversationTurnNavigatorCache,
): {
  assistantPreview: string;
  assistantPreviewKind: ConversationTurnNavigatorAssistantPreviewKind;
} {
  if (unit.assistantTextRows.length > 0) {
    return {
      assistantPreview: buildRowsPreview(
        unit.assistantTextRows,
        options.assistantEmptyPreview,
        options,
        cache,
      ),
      assistantPreviewKind: "text",
    };
  }

  if (unit.isRunning) {
    return {
      assistantPreview: options.assistantRunningPreview,
      assistantPreviewKind: "running",
    };
  }

  return {
    assistantPreview: options.assistantEmptyPreview,
    assistantPreviewKind: "empty",
  };
}

export function buildConversationTurnNavigatorItems(
  units: readonly ConversationTurnRenderUnit[],
  options: BuildConversationTurnNavigatorItemsOptions,
  cache?: ConversationTurnNavigatorCache,
): ConversationTurnNavigatorItem[] {
  const resolvedOptions: Required<BuildConversationTurnNavigatorItemsOptions> = {
    ...options,
    maxPreviewChars: options.maxPreviewChars ?? DEFAULT_MAX_PREVIEW_CHARS,
    maxPreviewParagraphs: options.maxPreviewParagraphs ?? DEFAULT_MAX_PREVIEW_PARAGRAPHS,
  };

  return units.flatMap((unit, unitIndex) => {
    const build = () => buildUnitNavigatorItems(unit, unitIndex, resolvedOptions, cache);
    return cache?.materialize(unit, unitIndex, resolvedOptions, build) ?? build();
  });
}

function buildUnitNavigatorItems(
  unit: ConversationTurnRenderUnit,
  unitIndex: number,
  resolvedOptions: Required<BuildConversationTurnNavigatorItemsOptions>,
  cache?: ConversationTurnNavigatorCache,
): ConversationTurnNavigatorItem[] {
  // provider/store 的物理 role=user 还包含 background/goal/mailbox
  // 等系统上下文；目录代表用户主动 query，只能使用投影明确裁决的 realUser。
  const realUserInputs = unit.visibleUserInputs.filter((row) => row.origin === "realUser");
  if (unit.timelineOnly || realUserInputs.length === 0) {
    return [];
  }

  // 导航项按 query 拆分，但 hover 的 assistant 摘要保持旧产品语义：
  // 取所属 product turn 的文本结果，不在 renderer 猜测 guide 回复分段。
  const { assistantPreview, assistantPreviewKind } = buildAssistantPreview(
    unit,
    resolvedOptions,
    cache,
  );
  return realUserInputs.map((row, queryIndex) => ({
    // 不能以 product turn 为目录粒度，并把同一 turn 的 steer query
    // 全部拼进一个 preview。目录真正导航的是用户可见 query，必须用稳定 row
    // 身份逐条建项，turnId 只负责把虚拟列表先定位到所属容器。
    key: `${unit.key}:query:${row.entityId ?? row.rowId}`,
    turnId: unit.turnId,
    unitIndex,
    rowId: row.rowId,
    userPreview: buildRowsPreview(
      [row],
      resolvedOptions.userFallbackPreview,
      resolvedOptions,
      cache,
    ),
    assistantPreview,
    assistantPreviewKind,
    // 同一 running product turn 可能已有多个已结束 guide segment；只有最后一条
    // query 仍代表当前工作，避免所有旧 query 一起呈现 running 强调。
    isRunning: unit.isRunning && queryIndex === realUserInputs.length - 1,
  }));
}

/**
 * 缓存只覆盖当前目录；未变历史轮不应因尾轮 token 或时钟重新扫描正文。
 * 输入按「历史 + 尾轮」分区：历史段条目按 history 引用缓存，每帧只为尾轮重建条目，
 * 尾轮条目值未变时直接返回上一份目录（预览最多 220 字，超过后流式正文不再改变条目）。
 */
export function createConversationTurnNavigatorItemsSelector() {
  type UnitCache = Map<
    string,
    { unit: ConversationTurnRenderUnit; index: number; items: ConversationTurnNavigatorItem[] }
  >;
  let historyCache: UnitCache = new Map();
  let tailCache: UnitCache = new Map();
  let previousOptions: BuildConversationTurnNavigatorItemsOptions | undefined;
  let history: {
    units: readonly ConversationTurnRenderUnit[];
    items: ConversationTurnNavigatorItem[];
  } | null = null;
  let previousTailItems: ConversationTurnNavigatorItem[] = [];
  let previousItems: ConversationTurnNavigatorItem[] = [];

  const selectUnitItems = (
    units: readonly ConversationTurnRenderUnit[],
    indexOffset: number,
    options: BuildConversationTurnNavigatorItemsOptions,
    lookup: (key: string) => ReturnType<UnitCache["get"]>,
    next: UnitCache,
  ) =>
    units.flatMap((unit, offset) => {
      const index = indexOffset + offset;
      const cached = lookup(unit.key);
      if (cached?.unit === unit && cached.index === index) {
        next.set(unit.key, cached);
        return cached.items;
      }
      const built = buildConversationTurnNavigatorItems([unit], options).map((item) => ({
        ...item,
        unitIndex: index,
      }));
      // running 时钟或不可见正文尾部变化，未必改变目录实际展示值。
      const stable = built.map((item, i) => {
        const old = cached?.items[i];
        return old &&
          Object.keys(item).every(
            (key) => item[key as keyof typeof item] === old[key as keyof typeof item],
          )
          ? old
          : item;
      });
      next.set(unit.key, { unit, index, items: stable });
      return stable;
    });

  return (
    units: ConversationTurnRenderUnitsPartition,
    options: BuildConversationTurnNavigatorItemsOptions,
  ) => {
    if (
      !previousOptions ||
      Object.keys({ ...previousOptions, ...options }).some(
        (key) =>
          options[key as keyof typeof options] !== previousOptions?.[key as keyof typeof options],
      )
    ) {
      historyCache.clear();
      tailCache.clear();
      history = null;
    }
    previousOptions = options;
    const previousHistoryCache = historyCache;
    const previousTailCache = tailCache;
    let historyChanged = false;
    if (history?.units !== units.history) {
      historyCache = new Map();
      history = {
        units: units.history,
        items: selectUnitItems(
          units.history,
          0,
          options,
          (key) => previousHistoryCache.get(key) ?? previousTailCache.get(key),
          historyCache,
        ),
      };
      historyChanged = true;
    }
    tailCache = new Map();
    const tailItems = selectUnitItems(
      units.tail,
      units.history.length,
      options,
      (key) => previousTailCache.get(key) ?? previousHistoryCache.get(key),
      tailCache,
    );
    if (!historyChanged && sameItems(tailItems, previousTailItems)) {
      return previousItems;
    }
    previousTailItems = tailItems;
    const items = [...history!.items, ...tailItems];
    if (sameItems(items, previousItems)) return previousItems;
    previousItems = items;
    return items;
  };
}
