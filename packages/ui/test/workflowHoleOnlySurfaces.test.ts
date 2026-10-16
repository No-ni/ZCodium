import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ConversationRow, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { ZCodePermissionRequest } from "@zcode/shared";
import type { ToolCallBlockRenderContext } from "../src/ToolCallBlocks/shared.js";
import {
  hasWorkflowGraphContent,
  type WorkflowCausalityGraphData,
} from "../src/components/workflow-graph/types.js";
import { buildWorkflowTimeline } from "../src/components/workflow-timeline/timeline-model.js";
import { laneRefsById } from "../src/components/workflow-graph/lane-name.js";
import {
  participantCounts,
  participantsOfPhase,
} from "../src/components/workflow-graph/participant-model.js";
import { toolCallCreateWorkflowDisplaySchema } from "@zcode/shared/zcode-protocol-v4";
import {
  buildWorkflowGraphByToolCallId,
  buildWorkflowRunByToolCallId,
} from "../src/v4/workflowRunCardJoin.js";
import { workflowNotificationOpenRequest } from "../src/v4/workflowHoleNotification.js";
import { WorkflowPermissionBlock } from "../src/WorkflowPermissionBlock.js";
import { CreateWorkflowToolCallBlock } from "../src/ToolCallBlocks/renderers/create-workflow.js";
import { WorkflowRunDigest } from "../src/components/workflow-timeline/WorkflowRunDigest.js";
import { WorkflowRunPhaseList } from "../src/app-shell/WorkflowRunPhaseList.js";

vi.mock("../src/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("../src/hooks/useWorkflowSubagentModelProviderName.js", () => ({
  useWorkflowSubagentModelProviderName: () => undefined,
}));
// 本测试验证图/站的真实 renderer；代码高亮与服务清单不属于留白图判定边界。
vi.mock("../src/components/ai-elements/code-block.js", () => ({ CodeBlock: () => null }));

const siteId = "hole#1234abcd";
const graph = {
  steps: [],
  lanes: [],
  participants: [],
  handoffs: [],
  phases: [{ id: siteId, name: "decide" }],
  phaseEdges: [],
  exits: [siteId],
  holes: [{ siteId, name: "decide", type: "string", tail: true }],
};
const emptyGraph = { steps: [], lanes: [], participants: [], handoffs: [], phases: [], holes: [] };
const display = {
  kind: "create_workflow" as const,
  ok: true,
  errorCount: 0,
  diagnostics: [],
  causalityGraph: graph,
};
const projection: WorkflowRunState = {
  runId: "run-1",
  toolCallId: "create",
  status: "running",
  actors: [],
  nodes: [],
  usage: { spentTokens: 0, nodesUsed: 0 },
  phaseNames: ["decide"],
  phaseHoles: [0],
  holes: [{ siteId, ordinal: 0, name: "decide", type: "string", state: "waiting", since: 1 }],
};
const row = {
  kind: "toolCall",
  toolName: "CreateWorkflow",
  toolCallId: "create",
  status: "success",
  display,
} as ConversationRow;
const summary = buildWorkflowRunByToolCallId([projection]).get("create")!;
const request = {
  requestId: "approval",
  toolName: "FillWorkflowHole",
  raw: { script: "return 'yes'", hole: { name: "decide", type: "string" } },
  display,
} as unknown as ZCodePermissionRequest;
function context(causalityGraph: WorkflowCausalityGraphData = graph): ToolCallBlockRenderContext {
  return {
    isRunning: false,
    workflowRun: summary,
    toolCallNode: {
      toolCall: {
        toolId: "create",
        toolName: "CreateWorkflow",
        input: {},
        raw: { display: { ...display, causalityGraph } },
        status: "completed",
      },
    },
  } as unknown as ToolCallBlockRenderContext;
}

describe("phase/hole-only workflow graphs on every surface", () => {
  it("keeps main hole dependencies without inventing a subagent on any renderer", () => {
    const complete: WorkflowCausalityGraphData = {
      ...graph,
      steps: [{ id: siteId, kind: "hole", label: "decide", phase: siteId, lane: "main" }],
      lanes: [{ id: "main" }, { id: "actor#1" }],
      participants: [{ id: "hole-main", phase: siteId, lane: "main", steps: [siteId] }],
      sink: [siteId],
    };
    expect(
      toolCallCreateWorkflowDisplaySchema.parse({ ...display, causalityGraph: complete }),
    ).toEqual({ ...display, causalityGraph: complete });
    expect(participantsOfPhase(complete, siteId)).toEqual([]);
    expect(participantCounts(complete, complete.participants[0]!)).toEqual({ asks: 0, reads: 0 });
    expect(laneRefsById(complete.lanes).get("actor#1")?.anonymousIndex).toBeUndefined();
    const model = buildWorkflowTimeline(complete, projection);
    expect(model.stations[0]?.hole?.siteId).toBe(siteId);
    expect(model.stations[0]?.pills).toEqual([]);
    const actualRequest = { ...request, display: { ...display, causalityGraph: complete } };
    const renderers = [
      createElement(WorkflowPermissionBlock, { request: actualRequest }),
      createElement(CreateWorkflowToolCallBlock, context(complete)),
      createElement(WorkflowRunDigest, {
        graph: complete,
        name: "Hole",
        runId: "run-1",
        summary,
        testIdKey: "complete-hole",
      }),
    ];
    for (const renderer of renderers) {
      const html = renderToStaticMarkup(renderer);
      expect(html).toContain('data-testid="workflow-timeline-station"');
      expect(html).toContain('data-hole="');
      expect(html).not.toContain("chat.toolCall.workflow.graph.lane.anonymous");
    }
    // 没有修改或删除分析事实；过滤只发生在参与者的展示选择器。
    expect(complete.participants).toHaveLength(1);
    expect(complete.sink).toEqual([siteId]);
  });
  it("preserves real anonymous agents and handoffs following a main hole", () => {
    const mixed: WorkflowCausalityGraphData = {
      ...graph,
      steps: [
        { id: siteId, kind: "hole", label: "decide", phase: siteId, lane: "main" },
        { id: "ask#1", kind: "ask", label: "work", phase: "after", lane: "actor#1" },
        { id: "ask#2", kind: "ask", label: "review", phase: "after", lane: "actor#2" },
      ],
      lanes: [{ id: "main" }, { id: "actor#1" }, { id: "actor#2" }],
      phases: [...graph.phases, { id: "after", name: "After" }],
      phaseEdges: [{ from: siteId, to: "after" }],
      participants: [
        { id: "hole-main", phase: siteId, lane: "main", steps: [siteId] },
        { id: "worker", phase: "after", lane: "actor#1", steps: ["ask#1"] },
        { id: "reviewer", phase: "after", lane: "actor#2", steps: ["ask#2"] },
      ],
      handoffs: [
        { from: "hole-main", to: "worker", types: ["string"] },
        { from: "worker", to: "reviewer" },
      ],
    };
    const refs = laneRefsById(mixed.lanes);
    expect(refs.get("actor#1")?.anonymousIndex).toBe(1);
    expect(refs.get("actor#2")?.anonymousIndex).toBe(2);
    const model = buildWorkflowTimeline(mixed);
    expect(model.stations[0]?.pills).toEqual([]);
    expect(model.stations[1]?.pills.map((pill) => pill.lane.id)).toEqual(["actor#1", "actor#2"]);
    expect(participantCounts(mixed, mixed.participants[1]!)).toEqual({ asks: 1, reads: 0 });
    expect(mixed.handoffs[0]).toEqual({ from: "hole-main", to: "worker", types: ["string"] });
  });
  it("joins tool rows and direct-launch rows even without steps, but not truly empty graphs", () => {
    expect(buildWorkflowGraphByToolCallId([row], [projection]).get("create")).toBe(graph);
    for (const kind of ["turnHeader", "userInput"] as const) {
      const launch = { kind, workflowLaunch: { toolCallId: "create", display } } as ConversationRow;
      expect(buildWorkflowGraphByToolCallId([launch]).get("create")).toBe(graph);
      expect(
        buildWorkflowGraphByToolCallId([
          {
            ...launch,
            workflowLaunch: {
              toolCallId: "create",
              display: { ...display, causalityGraph: emptyGraph },
            },
          } as ConversationRow,
        ]).size,
      ).toBe(0);
    }
    expect(
      buildWorkflowGraphByToolCallId([
        { ...row, display: { ...display, causalityGraph: emptyGraph } } as ConversationRow,
      ]).size,
    ).toBe(0);
    expect(hasWorkflowGraphContent(emptyGraph)).toBe(false);
    expect(hasWorkflowGraphContent(undefined)).toBe(false);
    expect(hasWorkflowGraphContent({ ...emptyGraph, phases: graph.phases })).toBe(true);
    expect(hasWorkflowGraphContent({ ...emptyGraph, holes: graph.holes })).toBe(true);
  });
  it("accepts a successful phase/hole-only fill and ignores a truly empty fill graph", () => {
    const fillGraph = {
      ...graph,
      phases: [...graph.phases, { id: "inserted", name: "Inserted", fill: siteId }],
    };
    const fillDisplay = {
      ...display,
      causalityGraph: fillGraph,
      fill: { siteId, name: "decide", commitSequence: 10 },
    };
    const fill = {
      ...row,
      toolCallId: "fill",
      toolName: "FillWorkflowHole",
      input: { run_id: "run-1" },
      display: fillDisplay,
    } as ConversationRow;
    const empty = {
      ...fill,
      toolCallId: "empty-fill",
      display: {
        ...fillDisplay,
        causalityGraph: emptyGraph,
        fill: { ...fillDisplay.fill, commitSequence: 11 },
      },
    } as ConversationRow;
    expect(buildWorkflowGraphByToolCallId([row, fill, empty], [projection]).get("create")).toBe(
      fillGraph,
    );
    expect(buildWorkflowGraphByToolCallId([row, empty], [projection]).get("create")).toBe(graph);
  });
  it("builds the original site station and keeps the notification landing target resolvable", () => {
    const joined = buildWorkflowGraphByToolCallId([row], [projection]).get("create")!;
    const model = buildWorkflowTimeline(joined, projection);
    const intent = workflowNotificationOpenRequest({
      parentSessionId: "session",
      toolCallId: "create",
      runId: "run-1",
      phaseId: siteId,
    });
    expect(intent?.phaseId).toBe(siteId);
    expect(model.stations.map((station) => station.id)).toEqual([siteId]);
    expect(model.stations.find((station) => station.id === intent?.phaseId)?.hole?.state).toBe(
      "waiting",
    );
    const pane = renderToStaticMarkup(
      createElement(WorkflowRunPhaseList, {
        graph: joined,
        model,
        run: projection,
        pendingQuestions: [],
        landing: { phaseId: siteId, key: "landing" },
      }),
    );
    expect(pane).toContain(`data-phase-id="${siteId}"`);
    expect(pane).toContain('data-testid="workflow-run-phase-lamp"');
  });
  it("renders the actual approval, tool-card and run-digest timeline lamps with zero steps", () => {
    const approval = renderToStaticMarkup(createElement(WorkflowPermissionBlock, { request }));
    const tool = renderToStaticMarkup(createElement(CreateWorkflowToolCallBlock, context()));
    const digest = renderToStaticMarkup(
      createElement(WorkflowRunDigest, {
        graph,
        name: "Hole",
        runId: "run-1",
        summary,
        testIdKey: "hole",
      }),
    );
    for (const html of [approval, tool, digest]) {
      expect(html).toContain('data-testid="workflow-timeline-station"');
      expect(html).toContain('data-hole="');
      expect(html).toContain("dashed");
    }
    expect(approval).toContain('data-hole="open"');
    expect(tool).toContain('data-hole="waiting"');
    expect(digest).toContain('data-hole="waiting"');
  });
  it("keeps truly empty approval, tool-card and digest free of timeline stations", () => {
    const approval = renderToStaticMarkup(
      createElement(WorkflowPermissionBlock, {
        request: { ...request, display: { ...display, causalityGraph: emptyGraph } },
      }),
    );
    const tool = renderToStaticMarkup(
      createElement(CreateWorkflowToolCallBlock, context(emptyGraph)),
    );
    const digest = renderToStaticMarkup(
      createElement(WorkflowRunDigest, {
        graph: emptyGraph,
        name: "Empty",
        runId: "run-1",
        summary,
        testIdKey: "empty",
      }),
    );
    for (const html of [approval, tool, digest])
      expect(html).not.toContain('data-testid="workflow-timeline-station"');
  });
});
