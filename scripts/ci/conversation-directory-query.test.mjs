import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { ConversationTurnDirectoryQuery } = await tsImport(
  "../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/conversation-turn-directory.ts",
  import.meta.url,
);

test("directory query reuses row derivation, follows branch replacement and stamps current watermarks", () => {
  const query = new ConversationTurnDirectoryQuery();
  const row = {
    rowId: 1,
    turnId: "synthetic-turn",
    kind: "userInput",
    origin: "realUser",
    text: "first",
  };
  const snapshot = { seq: 1, rows: { window: [row] } };
  const first = query.read(snapshot, {}, "epoch-a");
  row.text = "mutated without replacing the authoritative rows";
  const second = query.read({ ...snapshot, seq: 2 }, {}, "epoch-b");
  assert.equal(second.entries[0], first.entries[0]);
  assert.equal(second.entries[0].userPreview, "first");
  assert.equal(second.atSeq, 2);
  assert.equal(second.atLogEpoch, "epoch-b");
  const next = query.read(
    { seq: 3, rows: { window: [{ ...row, text: "replacement" }] } },
    {},
    "epoch-b",
  );
  assert.equal(next.entries[0].userPreview, "replacement");
  assert.notEqual(next.entries[0], first.entries[0]);
  const removed = query.read({ seq: 4, rows: { window: [] } }, {}, "epoch-b");
  assert.deepEqual(removed.entries, []);
});
