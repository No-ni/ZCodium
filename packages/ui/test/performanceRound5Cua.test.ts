import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assistantTextRowSchema,
  reasoningRowSchema,
  toolCallRowSchema,
  userInputRowSchema,
  type AssistantTextRow,
  type ReasoningRow,
  type ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";
import {
  prepareCuaGroupFlowItems,
  type ConversationCuaGroupRenderItem,
} from "@/v4/conversationCuaGroups.js";
import type { AssistantWorkRow, ConversationTurnFlowItem } from "@/v4/conversationTurnFlowItems.js";
import { prepareCuaGroupFlowItems as reference } from "./performanceRound5Cua.reference.js";

const base = (rowId: number) => ({ rowId, turnId: "turn", createdAt: rowId, createdAtSeq: rowId });
function tool(rowId: number, responseId?: string, cua = true): ToolCallRow {
  return toolCallRowSchema.parse({
    ...base(rowId),
    kind: "toolCall",
    toolCallId: `tool-${rowId}`,
    toolName: cua ? "mcp__computer-use__click" : "Read",
    status: "success",
    input: {},
    inputText: "{}",
    ...(responseId === undefined ? {} : { assistantResponseId: responseId }),
  });
}
function textRow(rowId: number, responseId?: string, streaming = false): AssistantTextRow {
  return assistantTextRowSchema.parse({
    ...base(rowId),
    kind: "assistantText",
    text: "body",
    state: streaming ? "streaming" : "complete",
    ...(responseId === undefined ? {} : { assistantResponseId: responseId }),
  });
}
function reasoning(rowId: number, responseId?: string): ReasoningRow {
  return reasoningRowSchema.parse({
    ...base(rowId),
    kind: "reasoning",
    text: "reason",
    state: "complete",
    ...(responseId === undefined ? {} : { assistantResponseId: responseId }),
  });
}
const work = (rows: AssistantWorkRow[]): ConversationTurnFlowItem => ({
  kind: "assistantWork",
  rows,
});
function freezeDeep<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value;
}
function groups(items: readonly ConversationTurnFlowItem[]): ConversationCuaGroupRenderItem[] {
  return items.filter((item): item is ConversationCuaGroupRenderItem => item.kind === "cuaGroup");
}
function compare(
  source: ConversationTurnFlowItem[],
  options: { enabled: boolean; stageTailIsRunning: boolean },
) {
  freezeDeep(source);
  const result = prepareCuaGroupFlowItems(source, options);
  expect(result).toEqual(reference(source, options));
  return result;
}

afterEach(() => vi.restoreAllMocks());

describe("CUA response membership work", () => {
  it("keeps a linear membership budget for 1,200 distinct adjacent responses", () => {
    const count = 1200;
    const source = freezeDeep([
      work(Array.from({ length: count }, (_, i) => tool(i, `response-${i}`))),
    ]);
    const includes = Array.prototype.includes;
    const has = Set.prototype.has;
    let candidates = 0;
    let lookups = 0;
    vi.spyOn(Array.prototype, "includes").mockImplementation(function (
      this: unknown[],
      value: unknown,
      fromIndex?: number,
    ) {
      if (typeof value === "string" && value.startsWith("response-")) candidates += this.length;
      return includes.call(this, value, fromIndex);
    });
    vi.spyOn(Set.prototype, "has").mockImplementation(function (
      this: Set<unknown>,
      value: unknown,
    ) {
      if (typeof value === "string" && value.startsWith("response-")) lookups++;
      return has.call(this, value);
    });
    const result = prepareCuaGroupFlowItems(source, { enabled: true, stageTailIsRunning: true });
    vi.restoreAllMocks();
    expect(groups(result)[0]?.assistantResponseIds).toHaveLength(count);
    expect(candidates).toBeLessThanOrEqual(count * 2);
    expect(lookups).toBe(count - 1);
  });

  it("deduplicates IDs in first-seen order while preserving repeated events and missing IDs", () => {
    const result = compare([work([tool(1), tool(2, "b"), tool(3, "a"), tool(4, "b"), tool(5)])], {
      enabled: true,
      stageTailIsRunning: true,
    });
    expect(groups(result)[0]?.assistantResponseIds).toEqual(["b", "a"]);
    expect(groups(result)[0]?.events).toHaveLength(5);
    expect(groups(result)[0]?.key).toBe("cua:1");
    expect(groups(result)[0]?.active).toBe(true);
  });

  it("resets membership at ordinary tool, text and user boundaries", () => {
    const user: ConversationTurnFlowItem = {
      kind: "userInput",
      row: userInputRowSchema.parse({
        ...base(8),
        kind: "userInput",
        text: "guide",
        origin: "realUser",
      }),
    };
    const result = compare(
      [
        work([
          tool(1, "same"),
          tool(2, "ordinary", false),
          tool(3, "same"),
          textRow(4, "plain"),
          tool(5, "same"),
        ]),
        user,
        work([tool(9, "same")]),
      ],
      { enabled: true, stageTailIsRunning: false },
    );
    expect(groups(result)).toHaveLength(4);
    for (const group of groups(result)) {
      expect(group.assistantResponseIds).toEqual(["same"]);
      expect(group.active).toBe(false);
      expect(group.node.toolCall.status).toBe("completed");
    }
  });

  it("preserves classification, streaming and reasoning boundaries and history flow kind", () => {
    compare(
      [
        {
          kind: "assistantHistory",
          rows: [reasoning(1, "pure"), textRow(2, "pure"), tool(3, "pure")],
        },
        { kind: "assistantText", row: textRow(4, "unknown", true), latest: true },
        work([
          reasoning(5),
          reasoning(6, "unknown"),
          tool(7, "next"),
          textRow(8, "mixed"),
          tool(9, "mixed"),
          tool(10, "mixed", false),
          tool(11, "after"),
        ]),
      ],
      { enabled: true, stageTailIsRunning: true },
    );
  });

  it("keeps an existing projected group immutable and starts an independent new group", () => {
    const previous = groups(
      prepareCuaGroupFlowItems([work([tool(1, "same")])], {
        enabled: true,
        stageTailIsRunning: true,
      }),
    )[0]!;
    const result = compare([work([tool(2, "same")]), previous, work([tool(3, "same")])], {
      enabled: true,
      stageTailIsRunning: false,
    });
    expect(groups(result)[1]).toBe(previous);
    expect(previous.active).toBe(true);
    expect(groups(result).map((group) => group.assistantResponseIds)).toEqual([
      ["same"],
      ["same"],
      ["same"],
    ]);
  });

  it.each([false, true])(
    "matches the frozen previous algorithm for mixed windows, running=%s",
    (running) => {
      for (let seed = 1; seed <= 20; seed++) {
        let state = seed;
        const random = () => {
          state = (state * 1664525 + 1013904223) >>> 0;
          return state;
        };
        const rows = Array.from({ length: 80 }, (_, rowId): AssistantWorkRow => {
          const responseId = random() % 5 === 0 ? undefined : `r-${random() % 7}`;
          const kind = random() % 4;
          if (kind === 0) return textRow(rowId, responseId, random() % 2 === 0);
          if (kind === 1) return reasoning(rowId, responseId);
          return tool(rowId, responseId, kind === 2);
        });
        const source: ConversationTurnFlowItem[] = [
          { kind: "assistantHistory", rows: rows.slice(0, 25) },
          work(rows.slice(25)),
        ];
        compare(source, { enabled: true, stageTailIsRunning: running });
        compare(source, { enabled: false, stageTailIsRunning: running });
      }
    },
  );
});
