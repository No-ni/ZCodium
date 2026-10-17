import { describe, expect, it } from "vitest";
import {
  applyConversationDelta,
  applyConversationDeltas,
  filterConversationDeltasForProfile,
  DELIVERY_PROFILES,
  type ConversationSnapshot,
  type ConversationDelta,
} from "@zcode/shared/zcode-protocol-v4";

const row = (rowId: number, text = "old") => ({
  kind: "assistantText" as const,
  rowId,
  turnId: "turn",
  createdAt: 1,
  createdAtSeq: rowId,
  state: "streaming" as const,
  text,
});
const snapshot = () =>
  ({ rows: { window: [row(1), row(3)], totalCount: 2, firstRowId: 1 } }) as ConversationSnapshot;
function freeze(value: unknown) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}

describe("atomic delta batches", () => {
  it.each(["continuous", "replayable"] as const)(
    "keeps missing-row and immutable single-update semantics for %s",
    (profile) => {
      const before = snapshot();
      freeze(before);
      const deltas: ConversationDelta[] = [
        { op: "row.delta", rowId: 2, path: "text", append: "missing" },
        { op: "row.upserted", row: row(2, "missing") },
        { op: "row.delta", rowId: 3, path: "text", append: " tail" },
        { op: "row.upserted", row: row(1, "first") },
      ];
      expect(applyConversationDelta(before, deltas[0]!)).toBe(before);
      expect(applyConversationDelta(before, deltas[1]!)).toBe(before);
      const filtered = filterConversationDeltasForProfile(deltas, DELIVERY_PROFILES[profile]);
      const result = filtered.reduce(applyConversationDelta, before);
      expect(result).toEqual(applyConversationDeltas(before, filtered));
      expect(result.rows.window).toEqual([row(1, "first"), row(3, "old tail")]);
      expect(before.rows.window).toEqual([row(1), row(3)]);
    },
  );

  it.each(["continuous", "replayable"] as const)(
    "matches sequential reduction for %s",
    (profile) => {
      const before = snapshot();
      freeze(before);
      const deltas: ConversationDelta[] = [
        { op: "row.delta", rowId: 3, path: "text", append: "a" },
        { op: "row.appended", row: row(8) },
        { op: "row.upserted", row: row(1, "replaced") },
        { op: "row.delta", rowId: 8, path: "text", append: "b" },
        { op: "row.removed", fromRowId: 3 },
        { op: "row.appended", row: row(12) },
        { op: "row.delta", rowId: 3, path: "text", append: "missing" },
        { op: "row.delta", rowId: 12, path: "text", append: "c" },
      ];
      const filtered = filterConversationDeltasForProfile(deltas, DELIVERY_PROFILES[profile]);
      expect(applyConversationDeltas(before, filtered)).toEqual(
        filtered.reduce(applyConversationDelta, before),
      );
      expect(before.rows.window.map((r) => r.rowId)).toEqual([1, 3]);
      expect(applyConversationDeltas(before, [])).toBe(before);
    },
  );

  it("preserves identity for a batch of unknown rows and retains untouched row references", () => {
    const before = snapshot();
    expect(
      applyConversationDeltas(
        before,
        [9, 10].map((rowId) => ({ op: "row.delta", rowId, path: "text", append: "x" })),
      ),
    ).toBe(before);
    const result = applyConversationDeltas(
      before,
      ["a", "b"].map((append) => ({ op: "row.delta", rowId: 3, path: "text", append })),
    );
    expect(result.rows.window[0]).toBe(before.rows.window[0]);
    expect(result.rows.window[1]).toMatchObject({ text: "oldab" });
  });

  it("clears branch anchors before appending a new branch", () => {
    const before = snapshot();
    const deltas: ConversationDelta[] = [
      { op: "row.removed", fromRowId: 1 },
      { op: "row.appended", row: row(20) },
    ];
    expect(applyConversationDeltas(before, deltas)).toEqual(
      deltas.reduce(applyConversationDelta, before),
    );
  });
});
