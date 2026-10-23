import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveWorkflowSchedulerState,
  type WorkflowGraph,
  type WorkflowGraphNode,
  type WorkflowNodeStatus,
} from "../src/workflow/index.js";
import { referenceSchedulerState } from "./workflow-scheduler.reference.js";

function node(id: string, overrides: Partial<WorkflowGraphNode> = {}): WorkflowGraphNode {
  return { id, title: id, kind: "task", status: "pending", dependsOn: [], ...overrides };
}

function freezeGraph(graph: WorkflowGraph): WorkflowGraph {
  for (const entry of graph.nodes) {
    Object.freeze(entry.dependsOn);
    Object.freeze(entry);
  }
  for (const edge of graph.edges) Object.freeze(edge);
  for (const collection of graph.collections ?? []) {
    if (collection.nodeIds) Object.freeze(collection.nodeIds);
    Object.freeze(collection);
  }
  Object.freeze(graph.nodes);
  Object.freeze(graph.edges);
  if (graph.collections) Object.freeze(graph.collections);
  return Object.freeze(graph);
}

test("scheduler adjacency preserves dependency and edge order with duplicate and missing IDs", () => {
  const graph = freezeGraph({
    nodes: [
      node("target", { dependsOn: ["discarded"] }),
      node("done", { status: "completed" }),
      node("failed", { status: "failed" }),
      node("skipped", { status: "skipped" }),
      node("cancelled", { status: "cancelled" }),
      node("target", { dependsOn: ["failed", "done", "failed"] }),
    ],
    edges: [
      { from: "done", to: "target" },
      { from: "missing", to: "target" },
      { from: "skipped", to: "target" },
      { from: "cancelled", to: "target" },
      { from: "missing", to: "target" },
      { from: "target", to: "target" },
      { from: "target", to: "unknown" },
    ],
  });
  const state = deriveWorkflowSchedulerState(graph);
  assert.deepEqual(state, referenceSchedulerState(graph));
  const target = state.nodes[0]!;
  assert.deepEqual(target.incoming, ["failed", "done", "missing", "skipped", "cancelled", "target"]);
  assert.deepEqual(target.outgoing, ["target", "unknown"]);
  assert.deepEqual(target.blockedBy, ["missing", "target"]);
  assert.equal(target.node, graph.nodes[0]);
  target.incoming.push("changed");
  assert.deepEqual(deriveWorkflowSchedulerState(graph), referenceSchedulerState(graph));
});

test("scheduler full projection matches the original for generated frozen graphs", () => {
  let seed = 0x71520349;
  const random = () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed;
  };
  const statuses: WorkflowNodeStatus[] = ["pending", "active", "completed", "failed", "skipped", "cancelled"];
  for (let sample = 0; sample < 180; sample++) {
    const graph = freezeGraph({
      nodes: Array.from({ length: random() % 35 }, () => node(`n${random() % 25}`, {
        status: statuses[random() % statuses.length],
        dependsOn: Array.from({ length: random() % 5 }, () => `n${random() % 30}`),
        ...(random() % 3 === 0 ? { collectionId: `c${random() % 4}` } : {}),
      })),
      edges: Array.from({ length: random() % 90 }, () => ({
        from: `n${random() % 30}`,
        to: `n${random() % 30}`,
      })),
      collections: Array.from({ length: random() % 5 }, (_, i) => ({
        collectionId: `c${i}`,
        nodeIds: Array.from({ length: random() % 10 }, () => `n${random() % 30}`),
        status: "active",
      })),
    });
    assert.deepEqual(deriveWorkflowSchedulerState(graph), referenceSchedulerState(graph));
  }
});

test("scheduler star adjacency does not repeatedly iterate accumulated edge prefixes", (t) => {
  const count = 800;
  const graph: WorkflowGraph = {
    nodes: [node("hub"), ...Array.from({ length: count }, (_, i) => node(`leaf-${i}`))],
    edges: Array.from({ length: count }, (_, i) => ({ from: "hub", to: `leaf-${i}` })),
  };
  const original = Array.prototype[Symbol.iterator];
  let stringVisits = 0;
  Array.prototype[Symbol.iterator] = function* () {
    for (const value of original.call(this)) {
      if (typeof value === "string") stringVisits++;
      yield value;
    }
  };
  let actual: ReturnType<typeof deriveWorkflowSchedulerState>;
  let expected: ReturnType<typeof deriveWorkflowSchedulerState>;
  let oldVisits: number;
  let newVisits: number;
  try {
    expected = referenceSchedulerState(graph);
    oldVisits = stringVisits;
    stringVisits = 0;
    actual = deriveWorkflowSchedulerState(graph);
    newVisits = stringVisits;
  } finally {
    Array.prototype[Symbol.iterator] = original;
  }
  assert.deepEqual(actual!, expected!);
  t.diagnostic(`string visits: original=${oldVisits!}, optimized=${newVisits!}`);
  assert.ok(oldVisits! >= (count * (count - 1)) / 2);
  assert.ok(newVisits! <= count * 5, `expected linear string visits, observed ${newVisits!}`);
});
