import type {
  ConversationDelta,
  ConversationRow,
  ConversationRowsPartition,
} from "@zcode/shared/zcode-protocol-v4";

// 分区只是不可变 rows 的派生值，不能持有第二份消息事实。
const EMPTY: ConversationRowsPartition = { history: [], tail: [] };
const partitions = new WeakMap<readonly ConversationRow[], ConversationRowsPartition>();

export function getConversationRowsPartition(
  rows: readonly ConversationRow[],
): ConversationRowsPartition {
  const existing = partitions.get(rows);
  if (existing) return existing;
  const last = rows.at(-1);
  if (!last) return EMPTY;
  const firstIndexByTurn = new Map<string, number>();
  rows.forEach((row, index) => {
    if (!firstIndexByTurn.has(row.turnId)) firstIndexByTurn.set(row.turnId, index);
  });
  let start = firstIndexByTurn.get(last.turnId)!;
  let checkedFrom = rows.length;
  // 交错轮次必须一起进入尾段，不能把一个 turn 拆到两个独立渲染缓存。
  while (start < checkedFrom) {
    let nextStart = start;
    for (let index = start; index < checkedFrom; index++) {
      nextStart = Math.min(nextStart, firstIndexByTurn.get(rows[index]!.turnId)!);
    }
    checkedFrom = start;
    start = nextStart;
  }
  const partition = { history: rows.slice(0, start), tail: rows.slice(start) };
  partitions.set(rows, partition);
  return partition;
}

/** 在唯一 owner 发布新 rows 前登记；只改尾轮时保持历史数组引用。 */
export function advanceConversationRowsPartition(
  previousRows: readonly ConversationRow[],
  nextRows: readonly ConversationRow[],
  deltas: readonly ConversationDelta[],
): void {
  if (nextRows === previousRows) return;
  const previous = partitions.get(previousRows);
  const tailStart = previous?.tail[0]?.rowId;
  if (!previous || tailStart === undefined) return;
  const tailTurns = new Set(previous.tail.map((row) => row.turnId));
  for (const delta of deltas) {
    switch (delta.op) {
      case "row.appended":
        if (!tailTurns.has(delta.row.turnId)) return;
        break;
      case "row.upserted":
        if (delta.row.rowId < tailStart || !tailTurns.has(delta.row.turnId)) return;
        break;
      case "row.delta":
        if (delta.rowId < tailStart) return;
        break;
      case "row.removed":
        if (delta.fromRowId <= tailStart) return;
        break;
      default:
        break;
    }
  }
  partitions.set(nextRows, {
    history: previous.history,
    tail: nextRows.slice(previous.history.length),
  });
}
