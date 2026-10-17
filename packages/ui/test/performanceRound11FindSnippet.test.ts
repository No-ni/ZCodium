import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildConversationFindIndex,
  resolveSearchResultHighlightMatch,
} from "@/v4/conversationFindIndex.js";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";
import type { ChatSearchResultHighlightRequest } from "@/v4/legacyChatViewTypes.js";

afterEach(() => vi.restoreAllMocks());

function indexFor(texts: string[]) {
  return buildConversationFindIndex(
    texts.map((text, i) => ({
      visibleUserInputs: [],
      assistantTextRows: [{ kind: "assistantText", rowId: i, text, state: "complete" }],
    })) as unknown as ConversationTurnRenderUnit[],
    "needle",
  );
}

function request(snippet?: string, snippetIndex?: number): ChatSearchResultHighlightRequest {
  return {
    requestId: 1,
    taskId: "fixture",
    workspacePath: "fixture",
    query: "needle",
    snippet,
    snippetIndex,
  };
}

function reference(index: ReturnType<typeof indexFor>, input: ChatSearchResultHighlightRequest) {
  if (index.matchCount === 0) return null;
  const normalize = (text: string) =>
    text
      .replace(/^\.{3}/, "")
      .replace(/\.{3}$/, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLocaleLowerCase();
  const snippet = input.snippet?.trim();
  if (snippet) {
    const found = index.matches.find((match) => {
      const text = normalize(match.sourceText);
      const probe = normalize(snippet);
      return probe.length > 0 && text.includes(probe);
    });
    if (found) return found;
  }
  return index.matches[input.snippetIndex ?? 0] ?? index.matches[0] ?? null;
}

describe("search-result snippet work", () => {
  it("normalizes a repeated source once instead of once per query hit", () => {
    const text = "needle ".repeat(1000);
    const index = indexFor([text]);
    const original = String.prototype.toLocaleLowerCase;
    let chars = 0;
    vi.spyOn(String.prototype, "toLocaleLowerCase").mockImplementation(function (this: string) {
      chars += this.length;
      return original.call(this);
    });
    expect(resolveSearchResultHighlightMatch(index, request("absent snippet", 700))).toBe(
      index.matches[700],
    );
    expect(chars).toBeLessThanOrEqual(text.length * 2);
    expect(chars).toBe(text.trim().length + "absent snippet".length);
  });

  it("preserves original selection identity and fallback for mixed snippet rules", () => {
    const index = indexFor([
      "needle needle first",
      "...NEEDLE\t target\ntext...",
      "needle needle first",
    ]);
    for (const snippet of [
      undefined,
      "",
      " \n ",
      "...",
      "......",
      "... target TEXT ...",
      "NEEDLE",
      "absent",
      "...first...",
    ]) {
      for (const snippetIndex of [undefined, 0, 2, -1, 100]) {
        const input = request(snippet, snippetIndex);
        expect(resolveSearchResultHighlightMatch(index, input)).toBe(reference(index, input));
      }
    }
  });

  it("does not confuse identical row ids with identical text and refreshes new input", () => {
    const first = indexFor(["needle", "needle target"]);
    for (const match of first.matches) match.rowId = 1;
    expect(resolveSearchResultHighlightMatch(first, request("target"))).toBe(first.matches[1]);
    const next = indexFor(["needle target", "needle"]);
    expect(resolveSearchResultHighlightMatch(next, request("target"))).toBe(next.matches[0]);
    expect(resolveSearchResultHighlightMatch(indexFor([]), request("target"))).toBeNull();
  });
});
