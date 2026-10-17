import { describe, expect, it } from "vitest";
import { buildConversationTurnNavigatorItems } from "@/v4/conversationTurnNavigatorHelpers.js";
import { ConversationTurnNavigatorCache } from "@/v4/conversationTurnNavigatorCache.js";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";

const options = {
  assistantEmptyPreview: "empty",
  assistantRunningPreview: "running",
  userFallbackPreview: "user",
};

function unit(id: number, text = "answer", read = () => {}) {
  return {
    key: `turn-${id}`,
    turnId: `turn-${id}`,
    timelineOnly: false,
    isRunning: false,
    visibleUserInputs: [{ rowId: id * 3, origin: "realUser", text: `query ${id}` }],
    assistantTextRows: [
      {
        get text() {
          read();
          return text;
        },
      },
    ],
  } as ConversationTurnRenderUnit;
}

describe("conversation navigator summary reuse", () => {
  it("does not reread history text when only the streaming tail changes", () => {
    let reads = 0;
    const history = Array.from({ length: 1000 }, (_, i) =>
      unit(i, "history ".repeat(200), () => reads++),
    );
    const cache = new ConversationTurnNavigatorCache();
    const first = buildConversationTurnNavigatorItems(
      [...history, unit(1001, "a")],
      options,
      cache,
    );
    expect(reads).toBe(1000);
    const changed = buildConversationTurnNavigatorItems(
      [...history, unit(1001, "ab")],
      options,
      cache,
    );
    expect(reads).toBe(1000);
    expect(changed[0]).toBe(first[0]);
    expect(changed.at(-1)?.assistantPreview).toBe("ab");
    expect(changed).toEqual(
      buildConversationTurnNavigatorItems([...history, unit(1001, "ab")], options),
    );
  });

  it("invalidates locale, preview limits, positions and same-ID replacement", () => {
    const cache = new ConversationTurnNavigatorCache();
    const old = unit(1, "first paragraph\n\nsecond paragraph");
    const blank = unit(2, "");
    const variants = [
      { units: [old, blank], options },
      { units: [old, blank], options: { ...options, assistantEmptyPreview: "空白" } },
      {
        units: [old, blank],
        options: { ...options, maxPreviewChars: 10, maxPreviewParagraphs: 1 },
      },
      { units: [unit(0), old, blank], options },
      { units: [old], options },
      { units: [unit(1, "another session")], options },
    ];
    for (const variant of variants) {
      expect(buildConversationTurnNavigatorItems(variant.units, variant.options, cache)).toEqual(
        buildConversationTurnNavigatorItems(variant.units, variant.options),
      );
    }
  });
});
