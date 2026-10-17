import { describe, expect, it } from "vitest";
import {
  buildConversationTurnDirectory,
  sliceTurnDirectory,
} from "../../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/conversation-turn-directory.js";
import {
  v4ConversationTurnDirectoryResultSchema,
  type ConversationRow,
} from "@zcode/shared/zcode-protocol-v4";
import { mergeTurnDirectory } from "@/v4/mergeTurnDirectory.js";

describe("bounded question directory", () => {
  it("keeps real-user guides separate and excludes tool payloads and synthetic users", () => {
    const rows = [
      { rowId: 1, turnId: "t", kind: "turnHeader", state: "running" },
      {
        rowId: 2,
        turnId: "t",
        kind: "userInput",
        origin: "realUser",
        text: "question ".repeat(5000),
      },
      { rowId: 3, turnId: "t", kind: "toolCall", inputText: "large input".repeat(5000) },
      { rowId: 4, turnId: "t", kind: "userInput", origin: "system", text: "hidden" },
      { rowId: 5, turnId: "t", kind: "userInput", origin: "realUser", guided: true, text: "guide" },
      {
        rowId: 6,
        turnId: "t",
        kind: "assistantText",
        state: "streaming",
        text: "answer ".repeat(5000),
      },
    ] as ConversationRow[];
    const entries = buildConversationTurnDirectory(rows);
    expect(entries.map((entry) => [entry.rowId, entry.isRunning])).toEqual([
      [2, false],
      [5, true],
    ]);
    expect(entries[0]!.userPreview.length).toBeLessThanOrEqual(220);
    expect(JSON.stringify(entries)).not.toContain("large input");
    expect(
      v4ConversationTurnDirectoryResultSchema.safeParse({
        entries,
        atSeq: 6,
        atLogEpoch: "epoch",
        hasMore: false,
      }).success,
    ).toBe(true);
  });
  it("pages 1000 queries independently of body rows and resolves unloaded targets", () => {
    const entries = Array.from({ length: 1000 }, (_, i) => ({
      rowId: i * 3,
      turnId: `t${i}`,
      userPreview: "question",
      assistantPreview: "answer",
      assistantPreviewKind: "text" as const,
      isRunning: false,
    }));
    const page = sliceTurnDirectory(entries, undefined, 200);
    expect(page.entries).toEqual(entries.slice(800));
    expect(sliceTurnDirectory(entries, page.entries[0]!.rowId, 200).entries).toEqual(
      entries.slice(600, 800),
    );
    const merged = mergeTurnDirectory([], entries, {
      user: "empty",
      empty: "empty",
      running: "running",
    });
    expect(merged[0]).toMatchObject({ rowId: 0, unitIndex: -1 });
  });
});
