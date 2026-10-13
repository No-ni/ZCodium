import { describe, expect, it } from "vitest";

import {
  WORKFLOW_HOLE_SITE_ID_PATTERN,
  readPhaseHoles,
  reduceHoleFilled,
  reduceHoleReached,
  withoutWaitingHoles,
} from "./workflow-runs-holes.js";
import { reduceWorkflowRunsState } from "./workflow-runs-reducer.js";
import { WORKFLOW_RUNS_LIMITS, type WorkflowRunState } from "./workflow-runs.js";

function baseRun(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    runId: "run-1",
    status: "running",
    usage: { spentTokens: 0, nodesUsed: 0 },
    actors: [],
    nodes: [],
    lastEventSequence: 0,
    ...overrides,
  };
}

describe("WORKFLOW_HOLE_SITE_ID_PATTERN", () => {
  it("recognizes name-keyed hole site ids", () => {
    expect(WORKFLOW_HOLE_SITE_ID_PATTERN.test("hole#21b40fca")).toBe(true);
    expect(WORKFLOW_HOLE_SITE_ID_PATTERN.test("hole#ABCDEF01")).toBe(false);
    expect(WORKFLOW_HOLE_SITE_ID_PATTERN.test("ask#1")).toBe(false);
  });
});

describe("readPhaseHoles", () => {
  it("drops out-of-range, non-integer and duplicate indexes", () => {
    expect(readPhaseHoles([2, 0, 0, -1, 1.5, 3, "1", null], 3)).toEqual([2, 0]);
  });

  it("returns undefined for a non-array or an empty result", () => {
    expect(readPhaseHoles(undefined, 3)).toBeUndefined();
    expect(readPhaseHoles([], 3)).toBeUndefined();
    expect(readPhaseHoles([5], 3)).toBeUndefined();
  });

  it("truncates at maxPhases", () => {
    const many = Array.from({ length: WORKFLOW_RUNS_LIMITS.maxPhases + 8 }, (_, i) => i);
    expect(readPhaseHoles(many, many.length)).toHaveLength(WORKFLOW_RUNS_LIMITS.maxPhases);
  });
});

describe("reduceHoleReached", () => {
  it("records a waiting hole keyed by site id", () => {
    const next = reduceHoleReached(baseRun(), {
      instance: { siteId: "hole#21b40fca", ordinal: 2 },
      name: "决定分组",
      type: "Plan",
      prompt: "need a plan",
      reachedAt: 100,
    });
    expect(next.holes).toEqual([
      {
        siteId: "hole#21b40fca",
        ordinal: 2,
        name: "决定分组",
        type: "Plan",
        prompt: "need a plan",
        state: "waiting",
        since: 100,
      },
    ]);
  });

  it("drops a record without a site id or name", () => {
    const run = baseRun();
    expect(reduceHoleReached(run, { instance: { ordinal: 1 }, name: "x" })).toBe(run);
    expect(reduceHoleReached(run, { instance: { siteId: "hole#x" }, name: "" })).toBe(run);
    expect(reduceHoleReached(run, { instance: null, name: "x" })).toBe(run);
  });

  it("upserts by site id, keeping the latest ordinal and the remembered type", () => {
    const first = reduceHoleReached(baseRun(), {
      instance: { siteId: "hole#21b40fca", ordinal: 1 },
      name: "决定分组",
      type: "Plan",
    });
    const second = reduceHoleReached(first, {
      instance: { siteId: "hole#21b40fca", ordinal: 7 },
      name: "决定分组",
    });
    expect(second.holes).toEqual([
      { siteId: "hole#21b40fca", ordinal: 7, name: "决定分组", type: "Plan", state: "waiting" },
    ]);
  });

  it("truncates the prompt at maxHolePromptLength with an ellipsis", () => {
    const long = "x".repeat(WORKFLOW_RUNS_LIMITS.maxHolePromptLength + 50);
    const next = reduceHoleReached(baseRun(), {
      instance: { siteId: "hole#21b40fca", ordinal: 0 },
      name: "p",
      prompt: long,
    });
    const prompt = next.holes?.[0]?.prompt ?? "";
    expect(prompt).toHaveLength(WORKFLOW_RUNS_LIMITS.maxHolePromptLength);
    expect(prompt.endsWith("…")).toBe(true);
  });

  it("refuses a new hole past maxHoles but flags truncated", () => {
    const holes = Array.from({ length: WORKFLOW_RUNS_LIMITS.maxHoles }, (_, i) => ({
      siteId: `hole#0000000${i.toString(16)}`,
      ordinal: 0,
      name: `h${i}`,
      state: "waiting" as const,
    }));
    const next = reduceHoleReached(baseRun({ holes }), {
      instance: { siteId: "hole#deadbeef", ordinal: 0 },
      name: "overflow",
    });
    expect(next.holes).toHaveLength(WORKFLOW_RUNS_LIMITS.maxHoles);
    expect(next.truncated).toBe(true);
  });

  it("does not mutate the input run (pure)", () => {
    const run = baseRun();
    const snapshot = JSON.stringify(run);
    reduceHoleReached(run, {
      instance: { siteId: "hole#21b40fca", ordinal: 0 },
      name: "p",
    });
    expect(JSON.stringify(run)).toBe(snapshot);
  });
});

describe("reduceHoleFilled", () => {
  const waiting = baseRun({
    holes: [
      {
        siteId: "hole#a20bc574",
        ordinal: 0,
        name: "outer",
        type: "string",
        prompt: "p",
        state: "waiting",
      },
    ],
    phaseNames: ["A", "outer", "D"],
    phaseAlongside: [[2], [], [1]],
    phaseHoles: [1],
  });

  it("flips the record to filled, drops the prompt and swaps the tables", () => {
    const next = reduceHoleFilled(waiting, {
      siteId: "hole#a20bc574",
      filledAt: 200,
      filledBy: "sess-1",
      phaseNames: ["A", "outer", "B", "inner", "C", "D"],
      holes: [3],
    });
    expect(next.holes).toEqual([
      {
        siteId: "hole#a20bc574",
        ordinal: 0,
        name: "outer",
        type: "string",
        state: "filled",
        filledAt: 200,
        filledBy: "sess-1",
      },
    ]);
    expect(next.holes?.[0]?.prompt).toBeUndefined();
    expect(next.phaseNames).toEqual(["A", "outer", "B", "inner", "C", "D"]);
    expect(next.phaseHoles).toEqual([3]);
    // 插入点 h = 1（A、outer 逐字相同）：引用插入点之后的下标 +3（old[0] = [2] → new[0] = [5]），
    // 引用插入点之前的下标不变（old[2] = [1] → new[5] = [1]）。
    expect(next.phaseAlongside?.[0]).toEqual([5]);
    expect(next.phaseAlongside?.[5]).toEqual([1]);
  });

  it("drops out-of-range and duplicate phaseHoles but still flips the state", () => {
    const next = reduceHoleFilled(waiting, {
      siteId: "hole#a20bc574",
      phaseNames: ["A"],
      holes: [0, 0, 4],
    });
    expect(next.phaseHoles).toEqual([0]);
    expect(next.holes?.[0]?.state).toBe("filled");
  });

  it("ignores a payload without a site id", () => {
    expect(reduceHoleFilled(waiting, { phaseNames: ["A"] })).toBe(waiting);
  });
});

describe("withoutWaitingHoles", () => {
  it("drops waiting records, keeps filled ones and removes an emptied key", () => {
    const mixed = baseRun({
      holes: [
        { siteId: "hole#00000001", ordinal: 0, name: "w", state: "waiting" },
        { siteId: "hole#00000002", ordinal: 0, name: "f", state: "filled" },
      ],
    });
    expect(withoutWaitingHoles(mixed).holes).toEqual([
      { siteId: "hole#00000002", ordinal: 0, name: "f", state: "filled" },
    ]);
    const onlyWaiting = baseRun({
      holes: [{ siteId: "hole#00000001", ordinal: 0, name: "w", state: "waiting" }],
    });
    expect(withoutWaitingHoles(onlyWaiting).holes).toBeUndefined();
    expect(withoutWaitingHoles(baseRun())).toEqual(baseRun());
  });
});

describe("reduceWorkflowRunsState hole integration", () => {
  function reduce(
    previous: ReturnType<typeof reduceWorkflowRunsState>,
    eventType: string,
    payload: Record<string, unknown>,
  ) {
    return reduceWorkflowRunsState(previous ?? undefined, {
      runId: "run-1",
      eventType,
      payload,
      sequence: 1,
    });
  }

  it("carries phaseNames + holes at launch and reduces hole-reached / hole-filled", () => {
    const launched = reduce(null, "run-launched", {
      phaseNames: ["摸底", "决定分组", "执行"],
      holes: [1],
    });
    const hole = "hole#21b40fca";
    expect(launched?.runs[0]?.phaseHoles).toEqual([1]);

    const reached = reduce(launched, "hole-reached", {
      instance: { siteId: hole, ordinal: 0 },
      name: "决定分组",
      type: "Plan",
    });
    expect(reached?.runs[0]?.holes?.[0]).toMatchObject({ siteId: hole, state: "waiting" });

    const filled = reduce(reached, "hole-filled", {
      siteId: hole,
      filledAt: 200,
      filledBy: "sess-1",
      phaseNames: ["摸底", "决定分组", "体", "执行"],
      holes: [],
    });
    expect(filled?.runs[0]?.holes?.[0]).toMatchObject({ state: "filled", filledBy: "sess-1" });
    expect(filled?.runs[0]?.phaseNames).toEqual(["摸底", "决定分组", "体", "执行"]);
    expect(filled?.runs[0]?.phaseHoles).toBeUndefined();
  });

  it("drops waiting holes on run-settled and on a new life (run-started)", () => {
    const reached = reduce(
      reduce(null, "run-launched", { phaseNames: ["A", "h"], holes: [1] }),
      "hole-reached",
      { instance: { siteId: "hole#deadbeef", ordinal: 0 }, name: "h" },
    );
    expect(reached?.runs[0]?.holes?.length).toBe(1);

    const settled = reduce(reached, "run-settled", { status: "completed" });
    expect(settled?.runs[0]?.holes).toBeUndefined();

    const restarted = reduce(reached, "run-started", {});
    expect(restarted?.runs[0]?.holes).toBeUndefined();
  });
});
