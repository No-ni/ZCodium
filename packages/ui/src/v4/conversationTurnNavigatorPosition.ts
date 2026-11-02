import type {
  ConversationTurnNavigatorBarVisualState,
  ConversationTurnNavigatorQueryPosition,
  ResolveConversationTurnNavigatorActiveQueryRowIdOptions,
  ResolveConversationTurnNavigatorActiveUnitIndexOptions,
  ResolveConversationTurnNavigatorBarVisualStateOptions,
  ResolveConversationTurnNavigatorVisualFocusItemIndexOptions,
} from "./conversationTurnNavigatorTypes.js";

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

  // items 由 renderUnits 顺序生成（同轮可有多个 query）。滚动只查少量可见轮，
  // 二分已有顺序即可，不能每个像素滚动都为完整目录重新分配 Map。
  const lowerBound = (unitIndex: number) => {
    let low = 0;
    let high = items.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (items[middle]!.unitIndex < unitIndex) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const viewportStart = resolveFiniteNonNegative(scrollOffsetPx);
  const viewportEnd = viewportStart + Math.max(1, resolveFiniteNonNegative(viewportHeightPx));

  let activeUnitIndex: number | undefined;
  let activeDistance = Number.POSITIVE_INFINITY;
  for (const virtualItem of virtualItems) {
    const item = items[lowerBound(virtualItem.index)];
    if (item?.unitIndex !== virtualItem.index) {
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
    items[lowerBound(topVirtualIndex)]?.unitIndex ?? items.at(-1)?.unitIndex ?? items[0]?.unitIndex
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
  let nearest: ConversationTurnNavigatorQueryPosition | undefined;
  let distance = Number.POSITIVE_INFINITY;
  let before: ConversationTurnNavigatorQueryPosition | undefined;
  let after: ConversationTurnNavigatorQueryPosition | undefined;
  // 保留原先按 start/rowId 排序后的距离与平局规则；无需每次 scroll 分配、排序三份数组。
  for (const position of positions) {
    const start = resolveFiniteNonNegative(position.start);
    const end = Math.max(start, resolveFiniteNonNegative(position.end));
    const candidate =
      start === position.start && end === position.end ? position : { ...position, start, end };
    const delta = Math.abs(start - viewportStart);
    if (
      end >= viewportStart &&
      start <= viewportEnd &&
      (delta < distance ||
        (delta === distance &&
          nearest &&
          (start < nearest.start || (start === nearest.start && position.rowId < nearest.rowId))))
    ) {
      nearest = candidate;
      distance = delta;
    }
    if (
      start <= viewportStart &&
      (!before || start > before.start || (start === before.start && position.rowId > before.rowId))
    )
      before = candidate;
    if (
      start > viewportStart &&
      (!after || start < after.start || (start === after.start && position.rowId < after.rowId))
    )
      after = candidate;
  }
  return nearest?.rowId ?? before?.rowId ?? after?.rowId;
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
