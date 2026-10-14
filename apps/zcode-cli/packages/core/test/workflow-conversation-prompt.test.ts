import assert from "node:assert/strict";
import { it } from "node:test";
import type { ExpertWorkflowRunSnapshot } from "@zcode/contracts";
import { createExpertWorkflowDefinition } from "../src/workflow/definition.js";
import {
  buildPhasePrompt,
  buildScheduledNodePrompt,
  createPhaseGraph,
} from "../src/workflow/expert/prompts.js";

it("does not present the workflow project bucket as the child execution directory", () => {
  const definition = createExpertWorkflowDefinition();
  const phase = definition.phases[0]!;
  const snapshot: ExpertWorkflowRunSnapshot = {
    activities: [],
    artifacts: [],
    createdAt: "2026-10-13T00:00:00.000Z",
    cwd: "/workspace/default",
    definitionId: definition.definitionId,
    definitionVersion: definition.definitionVersion,
    graph: createPhaseGraph(definition),
    kind: definition.kind,
    phaseOrder: definition.phaseOrder,
    phases: [],
    recoveryActions: [],
    runId: "workflow-test",
    schemaVersion: 1,
    sessionLinks: [],
    status: "pending",
    strategy: definition.strategy,
    task: "Write a report",
    updatedAt: "2026-10-13T00:00:00.000Z",
  };
  const node = {
    id: "report",
    title: "Report",
    kind: "task" as const,
    status: "pending" as const,
    dependsOn: [],
  };
  for (const prompt of [
    buildPhasePrompt(snapshot, phase),
    buildScheduledNodePrompt(snapshot, phase, node),
  ]) {
    assert.ok(prompt.includes("Workflow workspace: /workspace/default"));
    assert.ok(!prompt.includes("Working directory: /workspace/default"));
    assert.ok(prompt.includes("Write a report"));
  }
});
