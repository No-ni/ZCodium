import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationRowSchema,
  type ConversationRow,
} from "../../packages/shared/src/zcode-protocol-v4/index.js";
import {
  getConversationRowsPartition,
  advanceConversationRowsPartition,
} from "../../packages/ui/src/v4/conversationRowsPartition.js";
import {
  buildConversationTurnRenderUnits,
  createConversationTurnRenderUnitsSelector,
} from "../../packages/ui/src/v4/conversationTurnRenderUnits.js";
import {
  splitConversationTimelineLiveTail,
  resolveConversationLatestTurnSummary,
} from "../../packages/ui/src/v4/conversationTimelineLiveTail.js";

function row(
  rowId: number,
  turnId: string,
  kind: "userInput" | "assistantText" | "turnHeader",
  patch = {},
): ConversationRow {
  return conversationRowSchema.parse({
    rowId,
    turnId,
    productTurnId: turnId,
    createdAt: 1000,
    createdAtSeq: rowId,
    kind,
    ...(kind === "turnHeader"
      ? {
          origin: "userInput",
          state: "completedSuccess",
          startedAt: 1000,
          endedAt: 2000,
          executionKind: "agent",
        }
      : kind === "userInput"
        ? { text: "synthetic prompt", origin: "realUser" }
        : { text: "synthetic answer", state: "complete" }),
    ...patch,
  });
}
const flatten = (p: ReturnType<ReturnType<typeof createConversationTurnRenderUnitsSelector>>) => [
  ...p.history,
  ...p.tail,
];

test("Rows partitions preserve every row and keep whole turns on one side, including interleaving", () => {
  for (const turns of [
    [],
    ["a"],
    ["a", "a", "b"],
    ["a", "b", "a"],
    ["a", "b", "c", "b", "c"],
    ["a", "b", "c", "a", "d"],
  ]) {
    const rows = turns.map((turn, i) => row(i + 1, turn, "userInput"));
    const p = getConversationRowsPartition(rows);
    assert.deepEqual([...p.history, ...p.tail], rows);
    assert.equal(getConversationRowsPartition(rows), p);
    const historic = new Set(p.history.map((r) => r.turnId));
    assert.equal(
      p.tail.some((r) => historic.has(r.turnId)),
      false,
    );
  }
});

test("Tail deltas preserve history identity while history upsert, new turn and rewind invalidate it", () => {
  const a = [row(1, "a", "turnHeader"), row(2, "a", "userInput"), row(3, "a", "assistantText")];
  const b = [
    row(4, "b", "turnHeader", { state: "running", endedAt: undefined }),
    row(5, "b", "userInput"),
    row(6, "b", "assistantText", { state: "streaming" }),
  ];
  const rows = [...a, ...b];
  const initial = getConversationRowsPartition(rows);
  const changed = row(6, "b", "assistantText", { state: "streaming", text: "more synthetic text" });
  const next = [...rows.slice(0, -1), changed];
  advanceConversationRowsPartition(rows, next, [{ op: "row.upserted", row: changed }]);
  assert.equal(getConversationRowsPartition(next).history, initial.history);
  const prior = row(3, "a", "assistantText", { text: "corrected synthetic history" });
  const oldChanged = [rows[0]!, rows[1]!, prior, ...b];
  advanceConversationRowsPartition(rows, oldChanged, [{ op: "row.upserted", row: prior }]);
  assert.notEqual(getConversationRowsPartition(oldChanged).history, initial.history);
  const newRow = row(7, "c", "userInput");
  const newTurn = [...rows, newRow];
  advanceConversationRowsPartition(rows, newTurn, [{ op: "row.appended", row: newRow }]);
  assert.deepEqual(getConversationRowsPartition(newTurn).history, rows);
  const rewind = rows.slice(0, 3);
  advanceConversationRowsPartition(rows, rewind, [{ op: "row.removed", fromRowId: 4 }]);
  assert.deepEqual(getConversationRowsPartition(rewind).tail, a);
});

test("Partitioned render output matches the existing full builder across tail growth, phase and history changes", () => {
  const select = createConversationTurnRenderUnitsSelector();
  const history = [
    row(1, "a", "turnHeader"),
    row(2, "a", "userInput"),
    row(3, "a", "assistantText"),
  ];
  let priorRows: ConversationRow[] | null = null;
  let previous: ReturnType<typeof select> | null = null;
  for (let i = 0; i < 12; i++) {
    const tail = [
      row(4, "b", "turnHeader", { state: "running", endedAt: undefined }),
      row(5, "b", "userInput"),
      row(6, "b", "assistantText", { text: "token ".repeat(i + 1), state: "streaming" }),
    ];
    const rows = [...history, ...tail];
    if (priorRows)
      advanceConversationRowsPartition(
        priorRows,
        rows,
        tail.map((r) => ({ op: "row.upserted" as const, row: r })),
      );
    const options = { nowMs: 3000 + i * 1000, sessionPhase: "running" as const };
    const p = select(getConversationRowsPartition(rows), options);
    assert.deepEqual(flatten(p), buildConversationTurnRenderUnits(rows, options));
    if (previous) assert.equal(p.history, previous.history);
    const live = splitConversationTimelineLiveTail(p);
    assert.equal(live.virtualizedUnits, p.history);
    assert.equal(live.liveUnit, p.tail.at(-1));
    assert.equal(live.liveUnitIndex, 1);
    assert.equal(resolveConversationLatestTurnSummary(p.tail).answer, null);
    previous = p;
    priorRows = rows;
  }
  for (const rows of [
    history,
    [row(1, "a", "userInput"), row(2, "a", "assistantText", { state: "streaming" })],
    [row(1, "empty", "turnHeader")],
    [],
  ]) {
    for (const sessionPhase of [
      "running",
      "completedSuccess",
      "completedInterrupted",
      "error",
    ] as const) {
      const options = { nowMs: 5000, sessionPhase };
      assert.deepEqual(
        flatten(select(getConversationRowsPartition(rows), options)),
        buildConversationTurnRenderUnits(rows, options),
      );
    }
  }
});

test("Only the final running unit is lifted out of virtualization and summaries follow that same unit", () => {
  const units = buildConversationTurnRenderUnits(
    [
      row(1, "a", "turnHeader", { state: "running", endedAt: undefined }),
      row(2, "a", "userInput"),
      row(3, "b", "turnHeader"),
      row(4, "b", "userInput"),
      row(5, "b", "assistantText"),
    ],
    { nowMs: 5000 },
  );
  const split = splitConversationTimelineLiveTail({ history: units, tail: [] });
  assert.equal(split.liveUnit, null);
  assert.equal(split.virtualizedUnits, units);
  assert.deepEqual(resolveConversationLatestTurnSummary(units).answer, {
    rowId: 5,
    text: "synthetic answer",
  });
});
