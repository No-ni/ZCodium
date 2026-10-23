import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as contracts from "@zcode/contracts";
import * as graph from "../src/workflow/scheduler/graph.js";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import ts from "typescript";
import type { WorkflowGraphEdge, WorkflowGraphSeed, WorkflowRunSnapshot } from "@zcode/contracts";
import { applyWorkflowGraphSeed } from "../src/workflow/lifecycle.js";
import { applyPlannerExpansion } from "../src/workflow/scheduler/planner-expansion.js";
import { normalizeCollection } from "../src/workflow/scheduler/graph.js";

async function loadBaseline<T>(fixture: string): Promise<T> {
  const text = await readFile(
    new URL(`./fixtures/performance-workflow-edge-baseline/${fixture}.ts.txt`, import.meta.url),
    "utf8",
  );
  const code = ts.transpileModule(text, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  const require = (specifier: string) => {
    if (specifier === "@zcode/contracts") return contracts;
    if (specifier === "./graph.js") return graph;
    throw new Error(`Unexpected baseline dependency: ${specifier}`);
  };
  new Function("require", "exports", code)(require, exports);
  return exports as T;
}

const originalSeed = (
  await loadBaseline<{ applyWorkflowGraphSeed: typeof applyWorkflowGraphSeed }>("lifecycle")
).applyWorkflowGraphSeed;
const originalPlanner = (
  await loadBaseline<{ applyPlannerExpansion: typeof applyPlannerExpansion }>("planner-expansion")
).applyPlannerExpansion;
const timestamp = "2026-10-22T00:00:00.000Z";
const collection = normalizeCollection({ collectionId: "synthetic", nodeIds: [] });

function snapshot(ids: string[], edges: WorkflowGraphEdge[] = []): WorkflowRunSnapshot {
  return {
    activities: [],
    artifacts: [],
    createdAt: timestamp,
    cwd: "C:/synthetic",
    graph: {
      collections: [collection],
      edges,
      nodes: ids.map((id) => ({ id, title: id, kind: "task", status: "pending", dependsOn: [] })),
    },
    kind: "expert",
    phaseOrder: [],
    phases: [],
    recoveryActions: [],
    runId: "synthetic-run",
    schemaVersion: 1,
    sessionLinks: [],
    status: "running",
    strategy: {
      clarify: { confidenceThreshold: 0.8, maxRounds: 3, minRounds: 1 },
      executor: {
        drainingChangeHours: 1,
        frontierTarget: 1,
        maxConcurrentLoops: 2,
        maxConsecutiveErrors: 2,
        maxPlannerRuns: 2,
      },
      finalCritic: { maxIterations: 1 },
      reactLoop: { maxRounds: 2 },
    },
    task: "synthetic graph validation",
    updatedAt: timestamp,
  };
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function outcome(run: () => unknown): unknown {
  try {
    return { value: run() };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { error: { name: error.name, message: error.message } };
  }
}

const paths = [
  {
    name: "seed",
    run: (input: WorkflowRunSnapshot, seed: WorkflowGraphSeed) =>
      applyWorkflowGraphSeed(input, seed, { timestamp }),
    original: (input: WorkflowRunSnapshot, seed: WorkflowGraphSeed) =>
      originalSeed(input, seed, { timestamp }),
  },
  {
    name: "planner",
    run: (input: WorkflowRunSnapshot, seed: WorkflowGraphSeed) =>
      applyPlannerExpansion(
        input,
        collection,
        { ...seed, response: "synthetic", sessionId: "synthetic-planner" },
        [],
        timestamp,
      ),
    original: (input: WorkflowRunSnapshot, seed: WorkflowGraphSeed) =>
      originalPlanner(
        input,
        collection,
        { ...seed, response: "synthetic", sessionId: "synthetic-planner" },
        [],
        timestamp,
      ),
  },
];

function seed(edges: WorkflowGraphEdge[] = []): WorkflowGraphSeed {
  return { collections: [], edges, nodes: [] };
}

function random(seedValue: number): (limit: number) => number {
  let state = seedValue >>> 0;
  return (limit) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % limit;
  };
}

for (const path of paths) {
  test(`${path.name} equivalence: validation order, implicit edges and unchanged inputs`, () => {
    const cases: Array<[WorkflowRunSnapshot, WorkflowGraphSeed]> = [
      [snapshot([]), seed()],
      [
        snapshot(["a", "b", "c"]),
        seed([
          { from: "a", to: "b" },
          { from: "b", to: "c" },
        ]),
      ],
      [
        snapshot(["a"]),
        seed([
          { from: "a", to: "a" },
          { from: "missing", to: "a" },
        ]),
      ],
      [snapshot(["a"]), seed([{ from: "missing", to: "also-missing" }])],
      [snapshot(["a"]), seed([{ from: "a", to: "missing" }])],
      [snapshot(["a", "b"], [{ from: "a", to: "b" }]), seed([{ from: "a", to: "b" }])],
      [
        snapshot(["a", "b"]),
        seed([
          { from: "a", to: "b" },
          { from: "a", to: "b" },
        ]),
      ],
      [
        snapshot(["a", "b", "c"]),
        seed([
          { from: "a", to: "b" },
          { from: "b", to: "c" },
          { from: "c", to: "a" },
        ]),
      ],
      [
        snapshot(
          ["a", "b", "c"],
          [
            { from: "a", to: "b" },
            { from: "b", to: "a" },
          ],
        ),
        seed([{ from: "c", to: "a" }]),
      ],
      [
        snapshot(
          ["a", "b"],
          [
            { from: "unknown", to: "a" },
            { from: "a", to: "b" },
          ],
        ),
        seed([{ from: "b", to: "a" }]),
      ],
      [
        snapshot(["a"]),
        { ...seed(), nodes: [{ id: "b", title: "中文", kind: "task", dependsOn: ["a", "a"] }] },
      ],
      [
        snapshot(["a"]),
        { ...seed(), nodes: [{ id: "a", title: "duplicate", kind: "task", dependsOn: [] }] },
      ],
      [
        snapshot(["a"]),
        {
          ...seed(),
          nodes: [
            { id: "b", title: "b", kind: "task", dependsOn: ["a"] },
            { id: "c", title: "c", kind: "task", dependsOn: ["b"] },
          ],
          edges: [{ from: "c", to: "a" }],
        },
      ],
    ];
    for (const [input, addition] of cases) {
      freeze(input);
      freeze(addition);
      const expected = outcome(() => path.original(input, addition));
      const actual = outcome(() => path.run(input, addition));
      assert.deepEqual(actual, expected);
      if ("value" in (actual as object)) {
        const value = (actual as { value: { snapshot: WorkflowRunSnapshot } }).value;
        assert.equal(value.snapshot.graph.nodes[0], input.graph.nodes[0]);
        if (input.graph.edges.length > 0)
          assert.equal(value.snapshot.graph.edges[0], input.graph.edges[0]);
      }
    }
  });

  test(`${path.name} equivalence: 600 arbitrary graphs include pre-existing cycles and duplicate edges`, () => {
    for (let index = 1; index <= 600; index++) {
      const next = random(index);
      const ids = Array.from({ length: 2 + next(14) }, (_, id) => `node-${id}`);
      const candidates = [...ids, "unknown"];
      const edges = Array.from({ length: next(30) }, () => ({
        from: ids[next(ids.length)]!,
        to: ids[next(ids.length)]!,
      }));
      const addition = seed(
        Array.from({ length: next(24) }, () => ({
          from: candidates[next(candidates.length)]!,
          to: candidates[next(candidates.length)]!,
        })),
      );
      const input = freeze(snapshot(ids, edges));
      freeze(addition);
      assert.deepEqual(
        outcome(() => path.run(input, addition)),
        outcome(() => path.original(input, addition)),
        `graph ${index}`,
      );
    }
  });

  test(`${path.name} equivalence: accepted DAG extensions preserve complete snapshots`, () => {
    for (let index = 1; index <= 240; index++) {
      const next = random(index);
      const ids = Array.from({ length: 24 }, (_, id) => `node-${id}`);
      const existing: WorkflowGraphEdge[] = [];
      const added: WorkflowGraphEdge[] = [];
      for (let from = 0; from < ids.length; from++) {
        for (let to = from + 1; to < ids.length; to++) {
          const choice = next(10);
          if (choice === 0) existing.push({ from: ids[from]!, to: ids[to]! });
          if (choice === 1) added.push({ from: ids[from]!, to: ids[to]! });
        }
      }
      const input = freeze(snapshot(ids, existing));
      const addition = freeze(seed(added));
      assert.deepEqual(path.run(input, addition), path.original(input, addition), `DAG ${index}`);
    }
  });

  test(`${path.name} work budget: existing edges are not rescanned for every addition`, (context) => {
    const count = 1200;
    let reads = 0;
    const edges = Array.from({ length: count }, (_, index) => ({
      get from() {
        reads++;
        return `root-${index}`;
      },
      get to() {
        reads++;
        return `leaf-${index}`;
      },
    }));
    const input = snapshot(
      edges.flatMap((edge) => [edge.from, edge.to]),
      edges,
    );
    const addition = seed(
      Array.from({ length: 300 }, (_, index) => ({
        from: `leaf-${index}`,
        to: `leaf-${index + 1}`,
      })),
    );
    reads = 0;
    path.run(input, addition);
    context.diagnostic(
      `${path.name} existing=${count}, added=${addition.edges.length}, existingPropertyReads=${reads}`,
    );
    assert.ok(reads <= count * 12, `existing edge property reads ${reads} exceed ${count * 12}`);
  });

  test(`${path.name} work budget: empty additions and early errors do not build an unused index`, () => {
    for (const addition of [
      seed(),
      seed([{ from: "missing", to: "missing" }]),
      seed([{ from: "root", to: "root" }]),
      seed([{ from: "root", to: "leaf-0" }]),
    ]) {
      let reads = 0;
      const edges = Array.from({ length: 100 }, (_, index) => ({
        get from() {
          reads++;
          return "root";
        },
        get to() {
          reads++;
          return `leaf-${index}`;
        },
      }));
      const input = snapshot(["root", ...edges.map((edge) => edge.to)], edges);
      reads = 0;
      const expected = outcome(() => path.original(input, addition));
      const originalReads = reads;
      reads = 0;
      assert.deepEqual(
        outcome(() => path.run(input, addition)),
        expected,
      );
      assert.equal(reads, originalReads, "no adjacency allocation before the first cycle check");
    }
  });

  test(`${path.name} work budget: breadth-first traversal does not shift queued nodes`, () => {
    const leaves = Array.from({ length: 1200 }, (_, index) => `leaf-${index}`);
    const input = snapshot(
      ["root", "new-source", ...leaves],
      leaves.map((to) => ({ from: "root", to })),
    );
    const originalShift = Array.prototype.shift;
    let shifts = 0;
    Array.prototype.shift = function () {
      shifts++;
      return originalShift.call(this);
    };
    try {
      path.run(input, seed([{ from: "new-source", to: "root" }]));
    } finally {
      Array.prototype.shift = originalShift;
    }
    assert.equal(shifts, 0);
  });
}

test(
  "benchmark: graph expansion validation (synthetic alternating medians)",
  {
    skip: ![...process.argv, ...process.execArgv].some((arg) => arg.includes("benchmark")),
  },
  (context) => {
    for (const size of [100, 1000, 3000]) {
      const ids = Array.from({ length: size * 2 }, (_, index) => `node-${index}`);
      const input = snapshot(
        ids,
        Array.from({ length: size }, (_, index) => ({ from: ids[index]!, to: ids[size + index]! })),
      );
      const addition = seed(
        Array.from({ length: Math.floor(size / 3) }, (_, index) => ({
          from: ids[size + index]!,
          to: ids[size + index + 1]!,
        })),
      );
      for (const path of paths) {
        for (let warmup = 0; warmup < 4; warmup++) {
          path.original(input, addition);
          path.run(input, addition);
        }
        const times = { original: [] as number[], current: [] as number[] };
        for (let round = 0; round < 13; round++) {
          for (const kind of (round % 2
            ? ["current", "original"]
            : ["original", "current"]) as Array<keyof typeof times>) {
            const start = performance.now();
            if (kind === "original") path.original(input, addition);
            else path.run(input, addition);
            times[kind].push(performance.now() - start);
          }
        }
        const median = (values: number[]) =>
          values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!.toFixed(3);
        context.diagnostic(
          `${path.name} existing=${size}, added=${addition.edges.length}, original=${median(times.original)}ms, current=${median(times.current)}ms`,
        );
      }
    }
  },
);
