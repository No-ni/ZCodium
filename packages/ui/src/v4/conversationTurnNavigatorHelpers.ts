import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";
import type { ConversationTurnNavigatorCache } from "./conversationTurnNavigatorCache.js";

export type ConversationTurnNavigatorAssistantPreviewKind = "empty" | "running" | "text";

export interface ConversationTurnNavigatorItem {
  key: string;
  turnId: string;
  unitIndex: number;
  rowId: number;
  userPreview: string;
  assistantPreview: string;
  assistantPreviewKind: ConversationTurnNavigatorAssistantPreviewKind;
  isRunning: boolean;
}

export interface BuildConversationTurnNavigatorItemsOptions {
  assistantEmptyPreview: string;
  assistantRunningPreview: string;
  userFallbackPreview: string;
  maxPreviewChars?: number;
  maxPreviewParagraphs?: number;
}

export interface ConversationTurnNavigatorVirtualItem {
  index: number;
  start: number;
  size: number;
}

interface ResolveConversationTurnNavigatorActiveUnitIndexOptions {
  items: readonly ConversationTurnNavigatorItem[];
  virtualItems: readonly ConversationTurnNavigatorVirtualItem[];
  scrollOffsetPx: number;
  viewportHeightPx: number;
}

export interface ConversationTurnNavigatorQueryPosition {
  rowId: number;
  start: number;
  end: number;
}

interface ResolveConversationTurnNavigatorActiveQueryRowIdOptions {
  positions: readonly ConversationTurnNavigatorQueryPosition[];
  scrollOffsetPx: number;
  viewportHeightPx: number;
}

type ConversationTurnNavigatorBarTone = "idle" | "mid" | "near" | "peak";
type ConversationTurnNavigatorBarColorTone = "focus" | "muted";

interface ConversationTurnNavigatorBarVisualState {
  colorTone: ConversationTurnNavigatorBarColorTone;
  opacity: number;
  scaleX: number;
  tone: ConversationTurnNavigatorBarTone;
}

interface ResolveConversationTurnNavigatorBarVisualStateOptions {
  itemIndex: number;
  visualFocusItemIndex: number | undefined;
}

interface ResolveConversationTurnNavigatorVisualFocusItemIndexOptions {
  activeItemIndex: number;
  interactionItemIndex: number | undefined;
}

const CONVERSATION_TURN_NAVIGATOR_MIN_WIDTH_PX = 864;

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
  // 原 slice 会取整，NaN 则没有段落；保留旧数值选项与 UTF-16 截断规则。
  const paragraphLimit = Math.trunc(Math.max(1, maxPreviewParagraphs));
  if (!paragraphLimit) return fallback;
  const charLimit = Math.max(8, maxPreviewChars);
  const result: string[] = [];
  let length = 0;
  let paragraphs = 0;
  let pendingWhitespace = false;
  let pendingNewlines = 0;
  let firstSource = true;
  // 全文 join/split 曾随流式尾部重建反复扫描长正文；只读取能确定摘要的前缀。
  // 空白等下一处正文才提交，避免把末尾空白误当作超长内容而添加省略号。
  for (const text of texts) {
    if (!firstSource) {
      pendingWhitespace = true;
      pendingNewlines = 2;
    }
    firstSource = false;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      const whitespace =
        code === 32 || (code >= 9 && code <= 13) || (code > 127 && /\s/u.test(text[index]!));
      if (whitespace) {
        pendingWhitespace = true;
        if (code === 10) pendingNewlines = Math.min(2, pendingNewlines + 1);
        continue;
      }
      if (paragraphs === 0) {
        paragraphs = 1;
      } else if (pendingWhitespace) {
        if (pendingNewlines >= 2) {
          if (paragraphs >= paragraphLimit) return result.join("");
          paragraphs++;
          result.push("\n");
        } else {
          result.push(" ");
        }
        length++;
      }
      pendingWhitespace = false;
      pendingNewlines = 0;
      result.push(text[index]!);
      length++;
      if (Number.isNaN(charLimit) || length > charLimit) {
        return `${result
          .join("")
          .slice(0, charLimit - 3)
          .trimEnd()}...`;
      }
    }
  }
  return paragraphs === 0 ? fallback : result.join("");
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

function resolveFiniteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function resolveConversationTurnNavigatorActiveUnitIndex({
  items,
  virtualItems,
  scrollOffsetPx,
  viewportHeightPx,
}: ResolveConversationTurnNavigatorActiveUnitIndexOptions): number | undefined {
  if (items.length === 0) {
    return undefined;
  }

  const itemByUnitIndex = new Map(items.map((item) => [item.unitIndex, item]));
  const viewportStart = resolveFiniteNonNegative(scrollOffsetPx);
  const viewportEnd = viewportStart + Math.max(1, resolveFiniteNonNegative(viewportHeightPx));

  let activeUnitIndex: number | undefined;
  let activeDistance = Number.POSITIVE_INFINITY;
  for (const virtualItem of virtualItems) {
    const item = itemByUnitIndex.get(virtualItem.index);
    if (!item) {
      continue;
    }
    const rowStart = resolveFiniteNonNegative(virtualItem.start);
    const rowEnd = rowStart + Math.max(1, resolveFiniteNonNegative(virtualItem.size));
    if (rowEnd < viewportStart || rowStart > viewportEnd) {
      continue;
    }
    const distanceToViewportStart = rowStart <= viewportStart ? 0 : rowStart - viewportStart;
    if (distanceToViewportStart < activeDistance) {
      activeUnitIndex = item.unitIndex;
      activeDistance = distanceToViewportStart;
    }
  }

  if (activeUnitIndex !== undefined) {
    return activeUnitIndex;
  }

  const topVirtualIndex = virtualItems.find((item) => {
    const rowStart = resolveFiniteNonNegative(item.start);
    const rowEnd = rowStart + Math.max(1, resolveFiniteNonNegative(item.size));
    return rowEnd >= viewportStart && rowStart <= viewportEnd;
  })?.index;
  if (topVirtualIndex === undefined) {
    return items[0]?.unitIndex;
  }

  return (
    items.find((item) => item.unitIndex >= topVirtualIndex)?.unitIndex ??
    items.findLast((item) => item.unitIndex <= topVirtualIndex)?.unitIndex ??
    items[0]?.unitIndex
  );
}

export function resolveConversationTurnNavigatorActiveQueryRowId({
  positions,
  scrollOffsetPx,
  viewportHeightPx,
}: ResolveConversationTurnNavigatorActiveQueryRowIdOptions): number | undefined {
  if (positions.length === 0) return undefined;

  const viewportStart = resolveFiniteNonNegative(scrollOffsetPx);
  const viewportEnd = viewportStart + Math.max(1, resolveFiniteNonNegative(viewportHeightPx));
  const normalized = positions
    .map((position) => {
      const start = resolveFiniteNonNegative(position.start);
      return {
        rowId: position.rowId,
        start,
        end: Math.max(start, resolveFiniteNonNegative(position.end)),
      };
    })
    .sort((left, right) => left.start - right.start || left.rowId - right.rowId);

  const visible = normalized.filter(
    (position) => position.end >= viewportStart && position.start <= viewportEnd,
  );
  if (visible.length > 0) {
    return visible.reduce((nearest, candidate) =>
      Math.abs(candidate.start - viewportStart) < Math.abs(nearest.start - viewportStart)
        ? candidate
        : nearest,
    ).rowId;
  }

  return (
    normalized.findLast((position) => position.start <= viewportStart)?.rowId ??
    normalized.find((position) => position.start > viewportStart)?.rowId
  );
}

export function resolveConversationTurnNavigatorBarVisualState({
  itemIndex,
  visualFocusItemIndex,
}: ResolveConversationTurnNavigatorBarVisualStateOptions): ConversationTurnNavigatorBarVisualState {
  if (visualFocusItemIndex === undefined) {
    return { colorTone: "muted", opacity: 0.58, scaleX: 1, tone: "idle" };
  }

  const distance = Math.abs(itemIndex - visualFocusItemIndex);
  if (distance === 0) {
    return { colorTone: "focus", opacity: 1, scaleX: 2.6, tone: "peak" };
  }
  if (distance === 1) {
    return { colorTone: "muted", opacity: 0.86, scaleX: 1.7, tone: "near" };
  }
  if (distance === 2) {
    return { colorTone: "muted", opacity: 0.72, scaleX: 1.25, tone: "mid" };
  }
  return { colorTone: "muted", opacity: 0.58, scaleX: 1, tone: "idle" };
}

export function resolveConversationTurnNavigatorVisualFocusItemIndex({
  interactionItemIndex,
}: ResolveConversationTurnNavigatorVisualFocusItemIndexOptions): number | undefined {
  return interactionItemIndex;
}
