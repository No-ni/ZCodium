import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowGraph, WorkflowGraphCollection, WorkflowNodeStatus } from "@zcode/contracts";
import { collectionFrontier, collectionNodeIdsForGraph } from "../src/workflow/scheduler/graph.js";

function referenceFrontier(graph: WorkflowGraph, collection: WorkflowGraphCollection): number {
  return collectionNodeIdsForGraph(collection, graph).filter((id) => {
    const status = graph.nodes.find((node) => node.id === id)?.status;
    return status === "pending" || status === "active";
  }).length;
}

test("collection frontier preserves first duplicate node, implicit membership and missing IDs", () => {
  const graph: WorkflowGraph = {
    nodes: [
      { id: "duplicate", title: "first", kind: "task", dependsOn: [], status: "completed" },
      { id: "duplicate", title: "last", kind: "task", dependsOn: [], status: "active" },
      { id: "implicit", title: "implicit", kind: "task", dependsOn: [], status: "pending", collectionId: "c" },
      { id: "active", title: "active", kind: "task", dependsOn: [], status: "active" },
      { id: "failed", title: "failed", kind: "task", dependsOn: [], status: "failed" },
    ],
    edges: [],
  };
  const collection = { collectionId: "c", nodeIds: ["duplicate", "active", "active", "missing", "failed"] };
  assert.equal(collectionFrontier(graph, collection), 2);
  assert.equal(collectionFrontier(graph, collection), referenceFrontier(graph, collection));
  assert.equal(collectionFrontier(graph, { collectionId: "empty", nodeIds: [] }), 0);
});

test("collection frontier matches the original for frozen generated graphs", () => {
  let seed = 0x73502849;
  const random = () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed;
  };
  const statuses: WorkflowNodeStatus[] = ["pending", "active", "completed", "failed", "skipped", "cancelled"];
  for (let sample = 0; sample < 220; sample++) {
    const nodes = Array.from({ length: random() % 70 }, () => Object.freeze({
      id: `n${random() % 60}`, title: "fixture", kind: "task" as const, dependsOn: [],
      status: statuses[random() % statuses.length]!,
      ...(random() % 4 === 0 ? { collectionId: "c" } : {}),
    }));
    const collection = { collectionId: "c", nodeIds: Array.from({ length: random() % 70 }, () => `n${random() % 80}`) };
    Object.freeze(nodes);
    Object.freeze(collection.nodeIds);
    Object.freeze(collection);
    const graph = Object.freeze({ nodes, edges: [] });
    assert.equal(collectionFrontier(graph, collection), referenceFrontier(graph, collection));
  }
});

test("collection frontier visits node IDs once instead of scanning for every member", () => {
  let visits = 0;
  const count = 800;
  const graph: WorkflowGraph = {
    edges: [],
    nodes: Array.from({ length: count }, (_, i) => ({
      get id() {
        visits++;
        return `n${i}`;
      },
      title: "fixture", kind: "task", dependsOn: [], status: "pending",
    })),
  };
  const collection = { collectionId: "c", nodeIds: Array.from({ length: count }, (_, i) => `n${i}`) };
  assert.equal(referenceFrontier(graph, collection), count);
  assert.equal(visits, 320_400);
  visits = 0;
  assert.equal(collectionFrontier(graph, collection), count);
  assert.equal(visits, count);
});
