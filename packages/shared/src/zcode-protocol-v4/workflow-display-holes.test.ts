import { describe, expect, it } from "vitest";
import { toolCallCreateWorkflowDisplaySchema } from "./create-workflow-display.js";
import { workflowNotificationMetaSchema } from "./workflow-row-meta.js";

const siteId = "hole#1234abcd";
const graph = {
  steps: [{ id: siteId, kind: "hole", lane: "workspace", label: "Decide", phase: siteId }],
  lanes: [],
  participants: [],
  handoffs: [],
  phases: [
    { id: siteId, name: "Decide" },
    { id: "filled-step", name: "Filled", fill: siteId },
  ],
  phaseEdges: [],
  phaseStreams: [],
  holes: [{ siteId, name: "Decide", type: "string", tail: true }],
};

describe("holes display consumer contract", () => {
  it("accepts successful and refused create_workflow fill displays", () => {
    const fill = { siteId, name: "Decide", draftPath: "/draft/workflow.ts", line: 2 };
    for (const ok of [true, false]) {
      expect(
        toolCallCreateWorkflowDisplaySchema.safeParse({
          kind: "create_workflow",
          ok,
          errorCount: 0,
          diagnostics: [],
          causalityGraph: graph,
          fill,
        }).success,
      ).toBe(true);
    }
  });
  it("preserves strict optional durable fill sequence with the contracts nonnegative integer bound", () => {
    const display = {
      kind: "create_workflow",
      ok: true,
      errorCount: 0,
      diagnostics: [],
      fill: { siteId, name: "Decide" },
    };
    expect(toolCallCreateWorkflowDisplaySchema.parse(display).fill).not.toHaveProperty(
      "commitSequence",
    );
    for (const commitSequence of [0, 1, 123456]) {
      for (const ok of [true, false]) {
        expect(
          toolCallCreateWorkflowDisplaySchema.parse({
            ...display,
            ok,
            fill: { ...display.fill, commitSequence },
          }).fill?.commitSequence,
        ).toBe(commitSequence);
      }
    }
    for (const commitSequence of [-1, 0.5, "1", null, NaN, Infinity]) {
      expect(
        toolCallCreateWorkflowDisplaySchema.safeParse({
          ...display,
          fill: { ...display.fill, commitSequence },
        }).success,
      ).toBe(false);
    }
    expect(
      toolCallCreateWorkflowDisplaySchema.safeParse({
        ...display,
        fill: { ...display.fill, commitSequence: 1, unexpected: true },
      }).success,
    ).toBe(false);
  });
  it("accepts the actual phase/hole-only graph with zero steps", () => {
    const display = toolCallCreateWorkflowDisplaySchema.parse({
      kind: "create_workflow",
      ok: true,
      errorCount: 0,
      diagnostics: [],
      causalityGraph: { ...graph, steps: [], phases: [graph.phases[0]] },
    });
    expect(display.causalityGraph?.steps).toEqual([]);
    expect(display.causalityGraph?.holes?.[0]?.siteId).toBe(siteId);
    expect(display.causalityGraph?.phases?.[0]?.id).toBe(siteId);
  });
  it("accepts a backend hole notification manifest, rejects malformed fields", () => {
    const manifest = {
      kind: "hole",
      siteId,
      ordinal: 0,
      name: "Decide",
      type: "string",
      prompt: "Choose",
      reachedAt: 1,
    };
    expect(workflowNotificationMetaSchema.safeParse(manifest).success).toBe(true);
    expect(workflowNotificationMetaSchema.safeParse({ ...manifest, ordinal: -1 }).success).toBe(
      false,
    );
    expect(workflowNotificationMetaSchema.safeParse({ ...manifest, line: 0 }).success).toBe(false);
    expect(
      workflowNotificationMetaSchema.safeParse({ ...manifest, prompt: "x".repeat(4001) }).success,
    ).toBe(false);
  });
});
