import assert from "node:assert/strict";
import test from "node:test";
import {
  applyConversationDelta,
  applyConversationDeltas,
  coalesceConversationDeltas,
  conversationDeltaSchema,
  conversationSnapshotSchema,
  DELIVERY_PROFILES,
  filterConversationDeltasForProfile,
  toolCallRowSchema,
  workflowRunSchema,
  type ConversationDelta,
  type ConversationRow,
  type ConversationSnapshot,
} from "../src/zcode-protocol-v4/index.js";

function textRow(rowId: number, text = "base"): ConversationRow {
  return {
    kind: "assistantText",
    rowId,
    turnId: "fixture-turn",
    createdAt: 1,
    createdAtSeq: rowId,
    state: "streaming",
    text,
  };
}

function snapshot(): ConversationSnapshot {
  return conversationSnapshotSchema.parse({
    protocolVersion: 1,
    sessionId: "fixture-session",
    logEpoch: "fixture-epoch",
    seq: 0,
    control: {
      phase: "completedSuccess",
      sessionEnded: true,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: Object.fromEntries(
      [
        "fork",
        "compact",
        "switchModelConfig",
        "setFollowupMode",
        "queueEdit",
        "sendQueuedNow",
        "pauseGoal",
        "resumeGoal",
      ].map((key) => [key, { allowed: true }]),
    ),
    inputRouting: { mode: "startNow" },
    config: {
      provider: "fixture-provider",
      model: "fixture-model",
      thought: "",
      followupMode: "queue",
    },
    usage: {
      contextWindow: null,
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    rows: { window: [textRow(1), textRow(3)], totalCount: 2, firstRowId: 1 },
    revision: 0,
    queue: { items: [], autoDrain: true },
    workflowRuns: {
      revision: 0,
      runs: [
        workflowRunSchema.parse({
          runId: "fixture-run",
          status: "running",
          usage: { spentTokens: 0, nodesUsed: 0 },
          actors: [],
          nodes: [],
          lastEventSequence: 0,
        }),
      ],
    },
  });
}

function freeze(value: unknown): void {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}

for (const name of ["continuous", "replayable"] as const) {
  const profile = DELIVERY_PROFILES[name];
  test(`batch and coalesced apply preserve mixed final state for ${name}`, () => {
    const before = snapshot();
    const deltas: ConversationDelta[] = [
      { op: "row.delta", rowId: 2, path: "text", append: "unloaded" },
      { op: "row.delta", rowId: 3, path: "text", append: " draft" },
      { op: "state.updated", patch: { revision: 1 } },
      {
        op: "workflowRun.updated",
        runId: "fixture-run",
        revision: 1,
        run: { status: "completed" },
      },
      { op: "row.upserted", row: textRow(3, "base draft") },
      {
        op: "pluginUi.resourceListChanged",
        pluginId: "fixture-plugin",
        serverName: "fixture",
        subscribers: [],
      },
      { op: "row.removed", fromRowId: 3 },
      { op: "row.appended", row: textRow(8) },
      { op: "row.delta", rowId: 8, path: "text", append: " tail" },
      { op: "state.updated", patch: { revision: 2, queue: { items: [], autoDrain: false } } },
    ];
    deltas.forEach((delta) => assert.equal(conversationDeltaSchema.safeParse(delta).success, true));
    freeze(before);
    freeze(deltas);
    const filtered = filterConversationDeltasForProfile(deltas, profile);
    const expected = filtered.reduce(applyConversationDelta, before);
    assert.deepEqual(applyConversationDeltas(before, filtered), expected);
    assert.deepEqual(
      applyConversationDeltas(before, coalesceConversationDeltas(filtered)),
      expected,
    );
    assert.deepEqual(before.rows.window, [textRow(1), textRow(3)]);
    assert.deepEqual(expected.rows.window, [textRow(1), textRow(8, "base tail")]);
  });

  test(`zero and one row operations retain immutable behavior for ${name}`, () => {
    const before = snapshot();
    freeze(before);
    assert.equal(applyConversationDeltas(before, []), before);
    assert.equal(
      applyConversationDeltas(before, [{ op: "row.delta", rowId: 2, path: "text", append: "x" }]),
      before,
    );
    const deltas: ConversationDelta[] = [
      { op: "state.updated", patch: { revision: 1 } },
      { op: "row.delta", rowId: 3, path: "text", append: "x" },
      { op: "state.updated", patch: { revision: 2 } },
    ];
    const filtered = filterConversationDeltasForProfile(deltas, profile);
    const actual = applyConversationDeltas(before, filtered);
    assert.deepEqual(actual, filtered.reduce(applyConversationDelta, before));
    assert.equal(actual.rows.window[0], before.rows.window[0]);
    assert.notEqual(actual.rows.window, before.rows.window);
  });

  test(`a batch containing only unloaded rows retains its snapshot for ${name}`, () => {
    const before = snapshot();
    freeze(before);
    const deltas: ConversationDelta[] = [
      { op: "row.delta", rowId: 2, path: "text", append: "x" },
      { op: "row.upserted", row: textRow(99) },
    ];
    assert.equal(
      applyConversationDeltas(before, filterConversationDeltasForProfile(deltas, profile)),
      before,
    );
  });

  test(`final tool input closes filtered streaming updates for ${name}`, () => {
    const before = snapshot();
    const tool = toolCallRowSchema.parse({
      kind: "toolCall",
      rowId: 4,
      turnId: "fixture-turn",
      createdAt: 1,
      createdAtSeq: 4,
      toolCallId: "fixture-tool",
      toolName: "Bash",
      status: "inputStreaming",
      inputText: "",
    });
    const inputText = '{"command":"echo fixture"}';
    const deltas: ConversationDelta[] = [
      { op: "row.appended", row: tool },
      { op: "row.delta", rowId: tool.rowId, path: "inputText", append: inputText },
      { op: "row.upserted", row: { ...tool, status: "success", inputText } },
    ];
    deltas.forEach((delta) => assert.equal(conversationDeltaSchema.safeParse(delta).success, true));
    freeze(before);
    freeze(deltas);
    const filtered = filterConversationDeltasForProfile(deltas, profile);
    const expected = deltas.reduce(applyConversationDelta, before);
    assert.deepEqual(applyConversationDeltas(before, filtered), expected);
    assert.deepEqual(
      applyConversationDeltas(before, coalesceConversationDeltas(filtered)),
      expected,
    );
    assert.equal(
      filtered.filter((delta) => delta.op === "row.delta").length,
      name === "continuous" ? 1 : 0,
    );
  });
}

test("a 500-delta loaded-row batch stops its preliminary scan after the second row", (t) => {
  const before = snapshot();
  const source: ConversationDelta[] = Array.from({ length: 500 }, () => ({
    op: "row.delta",
    rowId: 3,
    path: "text",
    append: "x",
  }));
  source.forEach((delta) => assert.equal(conversationDeltaSchema.safeParse(delta).success, true));
  freeze(before);
  freeze(source);
  let opReads = 0;
  const deltas = source.map(
    (delta) =>
      new Proxy(delta, {
        get(target, key, receiver) {
          if (key === "op") opReads += 1;
          return Reflect.get(target, key, receiver);
        },
      }),
  );
  const actual = applyConversationDeltas(before, deltas);
  assert.deepEqual(actual, source.reduce(applyConversationDelta, before));
  assert.equal(actual.rows.window[0], before.rows.window[0]);
  assert.deepEqual(before.rows.window, [textRow(1), textRow(3)]);
  t.diagnostic(`deltas=${source.length}; op reads=${opReads}`);
  assert.ok(opReads <= 2_002, `Unnecessary complete pre-scan: ${opReads} op reads`);
});
