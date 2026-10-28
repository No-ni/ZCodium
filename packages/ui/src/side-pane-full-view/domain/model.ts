import type {
  ConversationPaneFloatingStatus,
  FloatingAnchor,
  FloatingAnswerBubbleState,
  FloatingPosition,
  FloatingRect,
  SidePaneFullViewState,
} from "../contract.js";

export const SIDE_PANE_FULL_VIEW_ENTER_STATE: SidePaneFullViewState = Object.freeze({
  surface: "side-pane",
  floating: "collapsed",
});
export const FLOATING_ANCHORS: readonly FloatingAnchor[] = [
  "top-left",
  "top-right",
  "left-center",
  "right-center",
  "bottom-left",
  "bottom-center",
  "bottom-right",
];
export const DEFAULT_FLOATING_ANCHOR: FloatingAnchor = "bottom-right";
export const FLOATING_MARGIN_PX = 16;
export const FLOATING_WIDTH_PX = 560;
export const FLOATING_EXPANDED_MAX_HEIGHT_PX = 640;
export const FLOATING_MINIMIZED_SIZE_PX = 48;
export const FLOATING_DRAG_CLICK_THRESHOLD_PX = 4;
const MAX_FLOATING_ANSWER_OWNERS = 50;
type FloatingSize = Pick<FloatingRect, "width" | "height">;

export function resolveFloatingWidth(slotWidth: number): number {
  return Math.max(0, Math.min(FLOATING_WIDTH_PX, slotWidth - FLOATING_MARGIN_PX * 2));
}

export function resolveFloatingExpandedHeight(slotHeight: number): number {
  return Math.max(
    0,
    Math.min(FLOATING_EXPANDED_MAX_HEIGHT_PX, slotHeight - FLOATING_MARGIN_PX * 2),
  );
}

export function clampFloatingPosition(
  position: FloatingPosition,
  slot: FloatingRect,
  size: FloatingSize,
): FloatingPosition {
  return {
    left: Math.max(slot.left, Math.min(position.left, slot.left + slot.width - size.width)),
    top: Math.max(slot.top, Math.min(position.top, slot.top + slot.height - size.height)),
  };
}

export function resolveFloatingPosition(
  anchor: FloatingAnchor,
  slot: FloatingRect,
  size: FloatingSize,
): FloatingPosition {
  const left = anchor.includes("left")
    ? slot.left + FLOATING_MARGIN_PX
    : anchor.includes("right")
      ? slot.left + slot.width - FLOATING_MARGIN_PX - size.width
      : slot.left + (slot.width - size.width) / 2;
  const top = anchor.startsWith("top")
    ? slot.top + FLOATING_MARGIN_PX
    : anchor.startsWith("bottom")
      ? slot.top + slot.height - FLOATING_MARGIN_PX - size.height
      : slot.top + (slot.height - size.height) / 2;
  return clampFloatingPosition({ left, top }, slot, size);
}

export function resolveFloatingTransformOrigin(anchor: FloatingAnchor): string {
  const x = anchor.includes("left") ? "left" : anchor.includes("right") ? "right" : "center";
  const y = anchor.startsWith("top") ? "top" : anchor.startsWith("bottom") ? "bottom" : "center";
  return `${x} ${y}`;
}

export function resolveNearestFloatingAnchor(
  position: FloatingPosition,
  slot: FloatingRect,
  size: FloatingSize,
): FloatingAnchor {
  let best = DEFAULT_FLOATING_ANCHOR;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const anchor of FLOATING_ANCHORS) {
    const resting = resolveFloatingPosition(anchor, slot, size);
    const distance = Math.hypot(resting.left - position.left, resting.top - position.top);
    if (distance < bestDistance) {
      best = anchor;
      bestDistance = distance;
    }
  }
  return best;
}

export function parseFloatingAnchor(raw: unknown): FloatingAnchor | null {
  return typeof raw === "string" && (FLOATING_ANCHORS as readonly string[]).includes(raw)
    ? (raw as FloatingAnchor)
    : null;
}

export function reduceFloatingAnswerBubbles(
  bubbles: ReadonlyMap<string, FloatingAnswerBubbleState>,
  status: Pick<ConversationPaneFloatingStatus, "ownerKey" | "latestTurn">,
): ReadonlyMap<string, FloatingAnswerBubbleState> {
  const turn = status.latestTurn;
  if (!turn?.turnKey) return bubbles;
  const current = bubbles.get(status.ownerKey) ?? { seenTurnKey: undefined, answer: null };
  let next = current;
  if (current.seenTurnKey === undefined) {
    next = { ...current, seenTurnKey: turn.running ? null : turn.turnKey };
  } else if (!turn.running && turn.answer && turn.turnKey !== current.seenTurnKey) {
    // 快速完成或回放可能从未渲染 running；末轮身份变化与 complete 回答共同证明新结果。
    next = { seenTurnKey: turn.turnKey, answer: turn.answer };
  }
  let recentOwner: string | undefined;
  for (const owner of bubbles.keys()) recentOwner = owner;
  if (next === current && recentOwner === status.ownerKey) return bubbles;
  const updated = new Map(bubbles);
  updated.delete(status.ownerKey);
  updated.set(status.ownerKey, next);
  // pane/logEpoch 会持续换代；展示缓存必须有界，重新访问被淘汰 owner 时只建立历史基线。
  if (updated.size > MAX_FLOATING_ANSWER_OWNERS) {
    const oldestOwner = updated.keys().next().value;
    if (oldestOwner !== undefined) updated.delete(oldestOwner);
  }
  return updated;
}

export function dismissFloatingAnswerBubble(
  bubbles: ReadonlyMap<string, FloatingAnswerBubbleState>,
  ownerKey: string,
): ReadonlyMap<string, FloatingAnswerBubbleState> {
  const current = bubbles.get(ownerKey);
  if (!current?.answer) return bubbles;
  const updated = new Map(bubbles);
  updated.set(ownerKey, { ...current, answer: null });
  return updated;
}

export function rebaselineFloatingAnswerBubbles(
  bubbles: ReadonlyMap<string, FloatingAnswerBubbleState>,
): ReadonlyMap<string, FloatingAnswerBubbleState> {
  if (![...bubbles.values()].some((bubble) => bubble.seenTurnKey !== undefined)) return bubbles;
  return new Map([...bubbles].map(([key, bubble]) => [key, { ...bubble, seenTurnKey: undefined }]));
}

export function resolveFloatingAnswerPreview(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|~~|\*)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
}
