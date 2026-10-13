import { describe, expect, it } from "vitest";
import type { WorkflowRunState, ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { buildWorkflowGraphByToolCallId } from "../src/v4/workflowRunCardJoin.js";
import {
  holeLampDashed,
  holeTable,
  phaseAlongsideOfRun,
} from "../src/components/workflow-timeline/timeline-holes.js";
import {
  holeRowState,
  workflowNotificationOf,
  workflowNotificationOpenRequest,
} from "../src/v4/workflowHoleNotification.js";
import { isFillWorkflowHoleToolCall } from "../src/lib/workflowToolNames.js";
import {
  readWorkflowFill,
  readWorkflowFillPreview,
  workflowFillKindMessageId,
} from "../src/ToolCallBlocks/renderers/workflowFillInput.js";
import { readWorkflowDisplay } from "../src/ToolCallBlocks/renderers/createWorkflowDisplay.js";
import { getZCodeToolFamilyForName, normalizeZCodeToolName } from "@zcode/shared";

const siteId = "hole#1234abcd";
const graph = {
  steps: [{ id: siteId, kind: "hole" as const, label: "Decide", phase: siteId, lane: "workspace" }],
  lanes: [],
  participants: [],
  handoffs: [],
  holes: [{ siteId, name: "Decide", type: "string" }],
};
const phases = [
  { id: "before", name: "Before" },
  { id: siteId, name: "Decide" },
  { id: "after", name: "After" },
];
function run(fields: Partial<WorkflowRunState>): WorkflowRunState {
  return {
    runId: "run-1",
    status: "running",
    actors: [],
    steps: [],
    ...fields,
  } as WorkflowRunState;
}
const notification = { kind: "hole" as const, siteId, ordinal: 0, name: "Decide", type: "string" };

describe("read-only hole timeline", () => {
  it("draws open/waiting lamps dashed, never filled or ordinary lamps", () => {
    const open = holeTable(graph, phases, undefined, undefined).byPhase.get(siteId);
    expect(holeLampDashed(open)).toBe(true);
    const waiting = run({
      phaseNames: ["Before", "Decide", "After"],
      phaseHoles: [1],
      holes: [{ ...notification, state: "waiting", since: 1 }],
    });
    expect(holeTable(graph, phases, waiting, undefined).byPhase.get(siteId)?.state).toBe("waiting");
    const filled = run({
      phaseNames: ["Before", "Decide", "After"],
      phaseHoles: [],
      holes: [{ ...notification, state: "filled", filledAt: 2 }],
    });
    const hole = holeTable(graph, phases, filled, undefined).byPhase.get(siteId);
    expect(hole?.state).toBe("filled");
    expect(holeLampDashed(hole)).toBe(false);
    expect(holeLampDashed(undefined)).toBe(false);
    expect(filled.phaseHoles).toEqual([]);
  });
  it("uses shifted reducer indices after insertion, not old display alongside", () => {
    const inserted = [
      ...phases.slice(0, 2),
      { id: "fill-a", name: "Fill A" },
      { id: "fill-b", name: "Fill B" },
      phases[2]!,
    ];
    const projection = run({
      phaseNames: ["Before", "Decide", "Fill A", "Fill B", "After"],
      phaseAlongside: [[4], [], [], [], [0]],
    });
    const map = phaseAlongsideOfRun(projection, inserted);
    expect(map?.get("before")).toEqual(["after"]);
    expect(map?.get("after")).toEqual(["before"]);
    expect(map?.get("fill-a")).toEqual([]);
    expect(projection.phaseAlongside).toEqual([[4], [], [], [], [0]]);
    expect(
      phaseAlongsideOfRun(
        run({ phaseNames: ["Before", "Decide", "After"], phaseAlongside: [[], [], []] }),
        phases,
      )?.get("before"),
    ).toEqual([]);
    expect(phaseAlongsideOfRun(run({}), phases)).toBeUndefined();
  });
});

function fillRow(toolCallId: string, commitSequence?: number, runId = "run-1"): ConversationRow {
  return {
    kind: "toolCall",
    toolCallId,
    toolName: "FillWorkflowHole",
    input: { run_id: runId },
    status: "success",
    display: {
      kind: "create_workflow",
      ok: true,
      diagnostics: [],
      errorCount: 0,
      fill: { siteId, name: "Decide", ...(commitSequence === undefined ? {} : { commitSequence }) },
      causalityGraph: {
        ...graph,
        phases: [...phases, { id: toolCallId, name: toolCallId, fill: siteId }],
      },
    },
  } as ConversationRow;
}
function graphOf(row: ConversationRow) {
  return row.kind === "toolCall" && row.display?.kind === "create_workflow"
    ? row.display.causalityGraph
    : undefined;
}

describe("latest successful fill graph join", () => {
  it("uses durable commit order B/A, not input order A/B, in either row ordering", () => {
    const a = fillRow("A", 20);
    const b = fillRow("B", 10);
    const projection = run({ toolCallId: "create" });
    for (const rows of [
      [a, b],
      [b, a],
    ]) {
      expect(buildWorkflowGraphByToolCallId(rows, [projection]).get("create")).toBe(graphOf(a));
    }
  });
  it("never rolls back on snapshot plus replay of an older commit, including duplicate replay", () => {
    const latest = fillRow("A", 20);
    const old = fillRow("B", 0);
    const projection = run({ toolCallId: "create" });
    const snapshotRows = [old, latest];
    for (const rows of [snapshotRows, [...snapshotRows, old], [latest, old, latest, old]]) {
      expect(buildWorkflowGraphByToolCallId(rows, [projection]).get("create")).toBe(
        graphOf(latest),
      );
    }
  });
  it("excludes failed, pending and refused displays even with a greater sequence", () => {
    const latest = fillRow("A", 20);
    const newer = fillRow("B", 30);
    const projection = run({ toolCallId: "create" });
    for (const status of ["error", "pendingApproval", "running", "inputStreaming"]) {
      expect(
        buildWorkflowGraphByToolCallId(
          [latest, { ...newer, status } as ConversationRow],
          [projection],
        ).get("create"),
      ).toBe(graphOf(latest));
    }
    if (newer.kind !== "toolCall" || newer.display?.kind !== "create_workflow")
      throw new Error("fixture");
    expect(
      buildWorkflowGraphByToolCallId(
        [latest, { ...newer, display: { ...newer.display, ok: false } }],
        [projection],
      ).get("create"),
    ).toBe(graphOf(latest));
  });
  it("isolates sequence comparison and launch identity per run", () => {
    const a = fillRow("A", 1);
    const b = fillRow("B", 100, "run-2");
    const other = fillRow("untracked", 200, "missing");
    const joined = buildWorkflowGraphByToolCallId(
      [a, b, other],
      [run({ toolCallId: "create" }), run({ runId: "run-2", toolCallId: "create-2" })],
    );
    expect(joined.get("create")).toBe(graphOf(a));
    expect(joined.get("create-2")).toBe(graphOf(b));
  });
  it("compatibly accepts a single legacy call, but retains the launch graph for ambiguous legacy calls", () => {
    const create = { ...fillRow("create"), toolName: "CreateWorkflow" } as ConversationRow;
    const a = fillRow("A");
    const b = fillRow("B");
    const projection = run({ toolCallId: "create" });
    expect(buildWorkflowGraphByToolCallId([create, a, a], [projection]).get("create")).toBe(
      graphOf(a),
    );
    for (const rows of [
      [create, a, b],
      [create, b, a],
    ]) {
      expect(buildWorkflowGraphByToolCallId(rows, [projection]).get("create")).toBe(
        graphOf(create),
      );
    }
    expect(buildWorkflowGraphByToolCallId([a, b], [projection]).get("create")).toBeUndefined();
  });
  it("always prefers sequenced success over legacy regardless of row order, including sequence zero", () => {
    const sequenced = fillRow("current", 0);
    const legacy = fillRow("legacy");
    const projection = run({ toolCallId: "create" });
    for (const rows of [
      [sequenced, legacy],
      [legacy, sequenced],
    ]) {
      expect(buildWorkflowGraphByToolCallId(rows, [projection]).get("create")).toBe(
        graphOf(sequenced),
      );
    }
  });
  it("updates the original launch graph without changing tab identity or admitting previews", () => {
    const projection = run({ toolCallId: "create" });
    const create = {
      kind: "toolCall",
      toolCallId: "create",
      toolName: "CreateWorkflow",
      status: "success",
      display: {
        kind: "create_workflow",
        ok: true,
        diagnostics: [],
        errorCount: 0,
        causalityGraph: graph,
      },
    } as ConversationRow;
    const updated = {
      ...graph,
      phases: [...phases, { id: "inserted", name: "Inserted", fill: siteId }],
    };
    const fill = {
      kind: "toolCall",
      toolCallId: "fill",
      toolName: "FillWorkflowHole",
      input: { run_id: "run-1" },
      status: "success",
      display: {
        kind: "create_workflow",
        ok: true,
        diagnostics: [],
        errorCount: 0,
        causalityGraph: updated,
      },
    } as ConversationRow;
    expect(buildWorkflowGraphByToolCallId([create, fill], [projection]).get("create")).toBe(
      updated,
    );
    expect(
      buildWorkflowGraphByToolCallId(
        [create, { ...fill, status: "pendingApproval" } as ConversationRow],
        [projection],
      ).get("create"),
    ).toBe(graph);
    expect(
      buildWorkflowGraphByToolCallId(
        [create, { ...fill, status: "error" } as ConversationRow],
        [projection],
      ).get("create"),
    ).toBe(graph);
    expect(buildWorkflowGraphByToolCallId([create, fill], []).get("create")).toBe(graph);
  });
});

describe("hole notification routing and actual site landing intent", () => {
  it("routes only workflow background results and preserves original launch identity", () => {
    const header = {
      origin: "backgroundResult",
      originMeta: { backgroundSource: "workflow", workflowNotification: notification },
    };
    expect(workflowNotificationOf(header)).toEqual(notification);
    expect(workflowNotificationOf({ ...header, origin: "user" })).toBeUndefined();
    expect(
      workflowNotificationOf({
        ...header,
        originMeta: { ...header.originMeta, backgroundSource: "bash" },
      }),
    ).toBeUndefined();
    expect(
      workflowNotificationOpenRequest({
        parentSessionId: "session",
        runId: "run-1",
        toolCallId: "original-create",
        workflowName: "Run",
        phaseId: siteId,
      }),
    ).toEqual({
      parentSessionId: "session",
      runId: "run-1",
      toolCallId: "original-create",
      workflowName: "Run",
      phaseId: siteId,
    });
    expect(
      workflowNotificationOpenRequest({ parentSessionId: "session", runId: "run-1" }),
    ).toBeUndefined();
  });
  it("reads waiting/filled from the projection and neutralizes evicted runs", () => {
    expect(holeRowState([{ ...notification, state: "waiting", since: 1 }], siteId)).toBe("waiting");
    expect(holeRowState([{ ...notification, state: "filled", filledAt: 2 }], siteId)).toBe(
      "filled",
    );
    expect(holeRowState(undefined, siteId)).toBe("left");
    expect(holeRowState([], siteId)).toBe("left");
  });
});

describe("fill identity, output and existing approval preview", () => {
  it("recognizes both canonical and wire names as workflow", () => {
    for (const name of ["FillWorkflowHole", "fill_workflow_hole", " FILL_WORKFLOW_HOLE "]) {
      expect(normalizeZCodeToolName(name)).toBe("FillWorkflowHole");
      expect(getZCodeToolFamilyForName(name)).toBe("workflow");
      expect(isFillWorkflowHoleToolCall({ toolName: name })).toBe(true);
    }
  });
  it("reuses create_workflow parsing for successful and refused fill results", () => {
    for (const ok of [true, false]) {
      const display = {
        kind: "create_workflow",
        ok,
        diagnostics: [],
        errorCount: 0,
        fill: { siteId, name: "Decide" },
        causalityGraph: graph,
      };
      expect(readWorkflowDisplay({ display })?.fill?.siteId).toBe(siteId);
      expect(readWorkflowDisplay({ display })?.causalityGraph?.steps[0]?.kind).toBe("hole");
      expect(workflowFillKindMessageId({ isRunning: false, failed: !ok })).toBe(
        ok ? "chat.toolCall.workflow.fill.done" : "chat.toolCall.workflow.fill.failed",
      );
    }
    expect(readWorkflowDisplay({ display: { kind: "create_workflow", ok: "yes" } })).toBeNull();
  });
  it("prefers backend effective preview without composing scripts or changing body bytes", () => {
    const body = "return 'yes';\n";
    const effective = "const x = 1;\nconst answer = hole<string>('Decide', () => {return 'yes';});";
    const input = {
      script: body,
      hole: {
        name: "Decide",
        type: "string",
        effective_script: effective,
        draft_path: "/draft/workflow.ts",
        line: 2,
      },
    };
    expect(readWorkflowFillPreview(input)).toEqual({ script: effective, complete: true });
    expect(readWorkflowFill(input)?.name).toBe("Decide");
    expect(readWorkflowFillPreview({ script: body })).toEqual({ script: body, complete: false });
    expect(input.script).toBe(body);
    expect(readWorkflowFillPreview({ path: "/draft/fill.ts" })).toBeUndefined();
  });
});
