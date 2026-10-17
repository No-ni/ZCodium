import { describe, expect, it } from "vitest";
import {
  applyConversationDelta,
  coalesceConversationDeltas,
  conversationDeltaSchema,
  DELIVERY_PROFILES,
  diffWorkflowRunsState,
  filterConversationDeltasForProfile,
  workflowRunSchema,
  type ConversationDelta,
  type ConversationRow,
  type ConversationSnapshot,
  type WorkflowRunsState,
  type WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";
import { coalesceConversationDeltasBeforeRound4 } from "./coalesceConversationDeltas.reference";

function row(rowId: number, text = "old"): ConversationRow {
  return {
    kind: "assistantText",
    rowId,
    turnId: "turn",
    createdAt: 1,
    createdAtSeq: rowId,
    state: "streaming",
    text,
  };
}

function run(runId: string): WorkflowRunState {
  return workflowRunSchema.parse({
    runId,
    status: "running",
    usage: { spentTokens: 0, nodesUsed: 0 },
    actors: [],
    nodes: [],
    lastEventSequence: 0,
  });
}

function snapshot(): ConversationSnapshot {
  return {
    rows: { window: [row(1), row(2)], totalCount: 2, firstRowId: 1 },
    queue: { items: [], autoDrain: true },
    workflowRuns: { revision: 0, runs: [run("a"), run("b"), run("c")] },
  } as ConversationSnapshot;
}

function freeze(value: unknown): void {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}

function assertEquivalent(before: ConversationSnapshot, deltas: ConversationDelta[]): void {
  deltas.forEach((delta) => expect(conversationDeltaSchema.safeParse(delta).success).toBe(true));
  freeze(before);
  freeze(deltas);
  for (const profile of [DELIVERY_PROFILES.continuous, DELIVERY_PROFILES.replayable]) {
    const filtered = filterConversationDeltasForProfile(deltas, profile);
    const expected = coalesceConversationDeltasBeforeRound4(filtered);
    const actual = coalesceConversationDeltas(filtered);
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
    expect(JSON.stringify(actual.reduce(applyConversationDelta, before))).toBe(
      JSON.stringify(filtered.reduce(applyConversationDelta, before)),
    );
  }
}

describe("coalesce skips windows with no eligible target", () => {
  it.each(["upserts", "unrelated row delta", "distinct workflow runs"] as const)(
    "uses linear property reads for %s",
    (kind) => {
      const count = 2_000;
      const deltas: ConversationDelta[] = Array.from({ length: count }, (_, index) =>
        kind === "distinct workflow runs"
          ? { op: "workflowRun.updated", runId: `r${index}`, revision: index }
          : { op: "row.upserted", row: row(index + 1) },
      );
      if (kind === "unrelated row delta") {
        deltas.unshift({ op: "row.delta", rowId: count + 1, path: "text", append: "x" });
      }
      deltas.forEach((delta) =>
        expect(conversationDeltaSchema.safeParse(delta).success).toBe(true),
      );
      let propertyReads = 0;
      const measured = deltas.map(
        (delta) =>
          new Proxy(delta, {
            get(target, key, receiver) {
              propertyReads += 1;
              return Reflect.get(target, key, receiver);
            },
          }),
      );
      expect(coalesceConversationDeltas(measured)).toHaveLength(deltas.length);
      expect(propertyReads).toBeLessThan(count * 30);
    },
  );

  it("retains row generations, row barriers, and workflow state barriers", () => {
    const deltas: ConversationDelta[] = [
      { op: "row.delta", rowId: 1, path: "text", append: "x" },
      { op: "state.updated", patch: { revision: 1 } },
      { op: "row.delta", rowId: 2, path: "text", append: "y" },
      { op: "row.upserted", row: row(1, "oldx") },
      { op: "workflowRun.updated", runId: "a", revision: 1, run: { status: "completed" } },
      { op: "row.removed", fromRowId: 1 },
      { op: "workflowRun.updated", runId: "a", revision: 2, run: { resultPreview: "done" } },
      { op: "row.appended", row: row(3) },
      { op: "row.delta", rowId: 3, path: "text", append: "z" },
      { op: "row.upserted", row: row(3, "oldz") },
      { op: "state.updated", patch: { workflowRuns: { revision: 3, runs: [run("a")] } } },
      { op: "workflowRun.updated", runId: "a", revision: 4, run: { status: "completed" } },
      { op: "workflowRun.removed", runId: "a", revision: 5 },
      ...diffWorkflowRunsState({ revision: 5, runs: [] }, { revision: 6, runs: [run("a")] }),
    ];
    assertEquivalent(snapshot(), deltas);
  });

  it("retains the last workflow target after a wire bounds rejection", () => {
    const before = snapshot();
    const deltas: ConversationDelta[] = [
      {
        op: "workflowRun.updated",
        runId: "a",
        revision: 1,
        removedActors: [{ siteId: "a", ordinal: 0 }],
      },
      {
        op: "workflowRun.updated",
        runId: "a",
        revision: 2,
        removedActors: [{ siteId: "b", ordinal: 0 }],
      },
      {
        op: "workflowRun.updated",
        runId: "a",
        revision: 3,
        actors: [{ siteId: "b", ordinal: 0, status: "waiting" }],
      },
    ];
    freeze(before);
    freeze(deltas);
    const bounds = { maxActors: 1, maxNodes: 1 };
    const actual = coalesceConversationDeltas(deltas, bounds);
    expect(actual).toHaveLength(2);
    expect(JSON.stringify(actual)).toBe(
      JSON.stringify(coalesceConversationDeltasBeforeRound4(deltas, bounds)),
    );
    expect(JSON.stringify(actual.reduce(applyConversationDelta, before))).toBe(
      JSON.stringify(deltas.reduce(applyConversationDelta, before)),
    );
  });

  it.each(["no earlier barrier", "earlier state barrier", "same run removed"] as const)(
    "restores run candidates after an explicit undefined (%s)",
    (kind) => {
      const before = snapshot();
      const deltas: ConversationDelta[] = [
        ...(kind === "earlier state barrier"
          ? ([
              { op: "workflowRun.updated", runId: "a", revision: 0, run: { status: "completed" } },
              { op: "state.updated", patch: { workflowRuns: before.workflowRuns } },
              { op: "row.delta", rowId: 1, path: "text", append: "x" },
            ] as ConversationDelta[])
          : []),
        { op: "workflowRun.updated", runId: "a", revision: 1, run: { status: "completed" } },
        ...(kind === "same run removed"
          ? ([{ op: "workflowRun.removed", runId: "a", revision: 1 }] as ConversationDelta[])
          : []),
        { op: "state.updated", patch: { workflowRuns: { revision: 2, runs: [] } } },
        { op: "state.updated", patch: { workflowRuns: undefined } },
        { op: "workflowRun.updated", runId: "a", revision: 3, run: { resultPreview: "done" } },
      ];
      deltas.forEach((delta) =>
        expect(conversationDeltaSchema.safeParse(delta).success).toBe(true),
      );
      freeze(before);
      freeze(deltas);
      const expected = coalesceConversationDeltasBeforeRound4(deltas);
      const actual = coalesceConversationDeltas(deltas);
      expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
      expect(JSON.stringify(actual.reduce(applyConversationDelta, before))).toBe(
        JSON.stringify(expected.reduce(applyConversationDelta, before)),
      );
    },
  );

  it("matches the previous wire sequence and sequential apply for legal mixed windows", () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const before = snapshot();
      let owner = before;
      let randomState = seed;
      let nextRowId = 3;
      const deltas: ConversationDelta[] = [];
      const random = (maximum: number) => {
        randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
        return randomState % maximum;
      };
      for (let step = 1; step <= 100; step += 1) {
        const loaded = owner.rows.window;
        const selected = loaded[random(loaded.length)] ?? row(nextRowId++);
        const choice = random(9);
        let incoming: ConversationDelta[];
        if (loaded.length === 0 || choice === 0) {
          incoming = [{ op: "row.appended", row: row(nextRowId++) }];
        } else if (choice === 1) {
          incoming = [{ op: "row.removed", fromRowId: selected.rowId }];
        } else if (choice === 2 || choice === 3) {
          incoming = [
            { op: "row.delta", rowId: selected.rowId, path: "text", append: String(step) },
          ];
        } else if (choice === 4) {
          incoming = [
            { op: "row.upserted", row: { ...selected, text: `replace${step}` } as ConversationRow },
          ];
        } else if (choice === 5) {
          incoming = [{ op: "state.updated", patch: { revision: step } }];
        } else {
          const prior = owner.workflowRuns!;
          const runId = ["a", "b", "c"][random(3)]!;
          const existing = prior.runs.find((item) => item.runId === runId);
          const updated = {
            ...(existing ?? run(runId)),
            lastEventSequence: step,
            resultPreview: `result${step}`,
          };
          const next: WorkflowRunsState = {
            revision: step,
            runs:
              choice === 6
                ? prior.runs.filter((item) => item.runId !== runId)
                : existing
                  ? prior.runs.map((item) => (item.runId === runId ? updated : item))
                  : [...prior.runs, updated],
          };
          incoming =
            choice === 8
              ? [{ op: "state.updated", patch: { workflowRuns: next } }]
              : diffWorkflowRunsState(prior, next);
        }
        deltas.push(...incoming);
        owner = incoming.reduce(applyConversationDelta, owner);
      }
      assertEquivalent(before, deltas);
    }
  });
});
