import { describe, expect, it } from "vitest";
import { buildConversationFindIndex } from "@/v4/conversationFindIndex.js";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";

describe("conversation find work with no query", () => {
  it.each([false, true])("does not read any body when comment projection is %s", (enabled) => {
    let bodyReads = 0;
    const units = Array.from({ length: 1000 }, (_, index) => {
      const row = {
        kind: "assistantText",
        rowId: index,
        state: "streaming",
        get text() {
          bodyReads++;
          return "large body ".repeat(100);
        },
      };
      return {
        key: `turn-${index}`,
        visibleUserInputs: [],
        assistantTextRows: [row],
        latestAssistantTextRow: row,
        isRunning: true,
      } as unknown as ConversationTurnRenderUnit;
    });
    expect(
      buildConversationFindIndex(units, " \n\t ", { projectAssistantCodeComments: enabled }),
    ).toEqual({ query: "", matches: [], matchCount: 0, loadedRowCount: 1000 });
    expect(bodyReads).toBe(0);
  });

  it("keeps user/assistant ordering and non-overlapping case-insensitive matches", () => {
    const unit = {
      visibleUserInputs: [{ kind: "userInput", rowId: 1, text: "AaAa" }],
      assistantTextRows: [{ kind: "assistantText", rowId: 2, text: "aa" }],
    } as unknown as ConversationTurnRenderUnit;
    const result = buildConversationFindIndex([unit], " AA ");
    expect(result.loadedRowCount).toBe(2);
    expect(
      result.matches.map(({ rowId, start, end, globalIndex }) => ({
        rowId,
        start,
        end,
        globalIndex,
      })),
    ).toEqual([
      { rowId: 1, start: 0, end: 2, globalIndex: 0 },
      { rowId: 1, start: 2, end: 4, globalIndex: 1 },
      { rowId: 2, start: 0, end: 2, globalIndex: 2 },
    ]);
  });
});
