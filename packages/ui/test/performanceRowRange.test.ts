import { describe, expect, it } from "vitest";
import { sliceConversationRowRange, type ConversationRow } from "@zcode/shared/zcode-protocol-v4";

describe("ordered history pagination", () => {
  const rows = [2, 4, 8, 20].map((rowId) => ({ rowId }) as ConversationRow);
  it.each([undefined, 0, 2, 3, 4, 9, 20, 21])("preserves cursor semantics at %s", (cursor) => {
    const eligible = rows.filter((r) => cursor === undefined || r.rowId < cursor);
    expect(sliceConversationRowRange(rows, cursor, 2)).toEqual({
      rows: eligible.slice(-2),
      hasMore: eligible.length > 2,
    });
  });
  it("accesses only a logarithmic search plus the returned page", () => {
    let reads = 0;
    const large = new Proxy(
      Array.from({ length: 100_000 }, (_, rowId) => ({ rowId }) as ConversationRow),
      {
        get(target, key, receiver) {
          if (typeof key === "string" && /^\d+$/.test(key)) reads++;
          return Reflect.get(target, key, receiver);
        },
      },
    );
    expect(sliceConversationRowRange(large, 90_000, 200).rows).toHaveLength(200);
    expect(reads).toBeLessThan(230);
  });
});
