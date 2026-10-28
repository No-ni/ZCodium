import { describe, expect, it } from "vitest";
import {
  clampFloatingPosition,
  dismissFloatingAnswerBubble,
  FLOATING_ANCHORS,
  parseFloatingAnchor,
  rebaselineFloatingAnswerBubbles,
  reduceFloatingAnswerBubbles,
  resolveFloatingAnswerPreview,
  resolveFloatingExpandedHeight,
  resolveFloatingPosition,
  resolveFloatingWidth,
  resolveNearestFloatingAnchor,
} from "./model.js";
import type { ConversationPaneFloatingStatus, FloatingAnswerBubbleState } from "../contract.js";

const slot = { left: 100, top: 50, width: 1000, height: 800 };
const size = { width: 560, height: 200 };
const status = (
  turnKey: string,
  running: boolean,
  ownerKey = "a",
  text = "answer",
): ConversationPaneFloatingStatus => ({
  running,
  ownerKey,
  blockingInteractionId: null,
  latestTurn: { turnKey, running, answer: running ? null : { rowId: 2, text } },
});

describe("full view geometry", () => {
  it("uses the seven official anchors and resolves each nearest resting position", () => {
    expect(FLOATING_ANCHORS).toHaveLength(7);
    for (const anchor of FLOATING_ANCHORS) {
      const position = resolveFloatingPosition(anchor, slot, size);
      expect(resolveNearestFloatingAnchor(position, slot, size)).toBe(anchor);
      expect(position.left).toBeGreaterThanOrEqual(slot.left);
      expect(position.top).toBeGreaterThanOrEqual(slot.top);
      expect(position.left + size.width).toBeLessThanOrEqual(slot.left + slot.width);
      expect(position.top + size.height).toBeLessThanOrEqual(slot.top + slot.height);
    }
  });
  it("contracts inside a narrow or empty slot without negative dimensions", () => {
    expect(resolveFloatingWidth(320)).toBe(288);
    expect(resolveFloatingWidth(10)).toBe(0);
    expect(resolveFloatingExpandedHeight(400)).toBe(368);
    expect(resolveFloatingExpandedHeight(10)).toBe(0);
    expect(clampFloatingPosition({ left: -1000, top: 9999 }, slot, size)).toEqual({
      left: 100,
      top: 650,
    });
  });
  it("accepts only the enumerated anchor preference", () => {
    expect(parseFloatingAnchor("bottom-right")).toBe("bottom-right");
    for (const raw of [null, {}, "center", "bottom-right "])
      expect(parseFloatingAnchor(raw)).toBeNull();
  });
});

describe("floating answers from one latest turn", () => {
  it("baselines completed history and recognizes a fast new completed answer without observing running", () => {
    let bubbles = reduceFloatingAnswerBubbles(new Map(), status("old", false));
    expect(bubbles.get("a")?.answer).toBeNull();
    bubbles = reduceFloatingAnswerBubbles(bubbles, status("new", false));
    expect(bubbles.get("a")?.answer?.text).toBe("answer");
  });
  it("first observes an in-flight turn and publishes its complete answer", () => {
    let bubbles = reduceFloatingAnswerBubbles(new Map(), status("new", true));
    bubbles = reduceFloatingAnswerBubbles(bubbles, status("new", false));
    expect(bubbles.get("a")?.answer?.rowId).toBe(2);
  });
  it("keeps the previous bubble during the next turn and replaces it on completion", () => {
    let bubbles = reduceFloatingAnswerBubbles(new Map(), status("one", true));
    bubbles = reduceFloatingAnswerBubbles(bubbles, status("one", false));
    bubbles = reduceFloatingAnswerBubbles(bubbles, status("two", true));
    expect(bubbles.get("a")?.answer?.text).toBe("answer");
    bubbles = reduceFloatingAnswerBubbles(bubbles, status("two", false, "a", "second"));
    expect(bubbles.get("a")?.answer?.text).toBe("second");
  });
  it("isolates pane, workspace and log-epoch owners", () => {
    let bubbles: ReadonlyMap<string, FloatingAnswerBubbleState> = new Map();
    for (const owner of [
      "workspace-a/pane/epoch-a",
      "workspace-b/pane/epoch-a",
      "workspace-a/pane/epoch-b",
    ]) {
      bubbles = reduceFloatingAnswerBubbles(bubbles, status("one", true, owner));
      bubbles = reduceFloatingAnswerBubbles(bubbles, status("one", false, owner, owner));
    }
    expect(bubbles.size).toBe(3);
    expect(bubbles.get("workspace-b/pane/epoch-a")?.answer?.text).toBe("workspace-b/pane/epoch-a");
  });
  it("dismisses only the current owner's answer and keeps its seen baseline", () => {
    let bubbles = reduceFloatingAnswerBubbles(new Map(), status("one", true));
    bubbles = reduceFloatingAnswerBubbles(bubbles, status("one", false));
    bubbles = dismissFloatingAnswerBubble(bubbles, "a");
    expect(bubbles.get("a")).toEqual({ seenTurnKey: "one", answer: null });
    expect(reduceFloatingAnswerBubbles(bubbles, status("one", false))).toBe(bubbles);
  });
  it("rebaselines viewed conversation without removing already shown answers", () => {
    let bubbles = reduceFloatingAnswerBubbles(new Map(), status("one", true));
    bubbles = reduceFloatingAnswerBubbles(bubbles, status("one", false));
    bubbles = rebaselineFloatingAnswerBubbles(bubbles);
    expect(bubbles.get("a")?.answer?.text).toBe("answer");
    bubbles = reduceFloatingAnswerBubbles(bubbles, status("viewed", false, "a", "viewed"));
    expect(bubbles.get("a")?.answer?.text).toBe("answer");
  });
  it("does not turn a missing or partial final answer into a bubble", () => {
    let bubbles = reduceFloatingAnswerBubbles(new Map(), status("one", true));
    bubbles = reduceFloatingAnswerBubbles(bubbles, {
      ...status("one", false),
      latestTurn: { turnKey: "one", running: false, answer: null },
    });
    expect(bubbles.get("a")?.answer).toBeNull();
  });
  it("bounds remembered owners and rebaselines an evicted completed owner", () => {
    let bubbles: ReadonlyMap<string, FloatingAnswerBubbleState> = new Map();
    for (let index = 0; index < 50; index++)
      bubbles = reduceFloatingAnswerBubbles(bubbles, status("old", false, `owner-${index}`));
    const retained = reduceFloatingAnswerBubbles(bubbles, status("old", false, "owner-0"));
    const updated = reduceFloatingAnswerBubbles(retained, status("old", false, "owner-50"));
    expect(updated.size).toBe(50);
    expect(updated.has("owner-0")).toBe(true);
    expect(updated.has("owner-1")).toBe(false);
    const revisited = reduceFloatingAnswerBubbles(updated, status("completed", false, "owner-1"));
    expect(revisited.size).toBe(50);
    expect(revisited.get("owner-1")?.answer).toBeNull();
  });
  it("renders only a compact plain-text preview", () => {
    expect(
      resolveFloatingAnswerPreview(
        "# Result\n**Ready** [guide](https://example.invalid) `snake_case`\n```ts\nsecret\n```",
      ),
    ).toBe("Result Ready guide snake_case");
  });
});
