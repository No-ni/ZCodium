import type { ConversationRow } from "./rows.js";

/** rowId 严格有序；游标可落在 rewind 留下的空洞里。 */
export function conversationRowLowerBound(rows: readonly ConversationRow[], rowId: number): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (rows[middle]!.rowId < rowId) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function sliceConversationRowRange(
  rows: readonly ConversationRow[],
  beforeRowId: number | undefined,
  limit: number,
): { rows: ConversationRow[]; hasMore: boolean } {
  // 旧实现每页复制再过滤全量行；二分后只复制返回区间，分页成本不随完整历史线性增长。
  const end =
    beforeRowId === undefined ? rows.length : conversationRowLowerBound(rows, beforeRowId);
  const start = Math.max(0, end - limit);
  return { rows: rows.slice(start, end), hasMore: start > 0 };
}
