import assert from "node:assert/strict";
import { it } from "node:test";
import {
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  FILL_WORKFLOW_HOLE_TOOL_NAME,
  CreateWorkflowCausalityGraphSchema,
  completedToolPartMetadataSchema,
  parseCompletedToolPartMetadata,
  parseToolResultDisplayPayload,
} from "@zcode/contracts";
import { toolCallCreateWorkflowDisplaySchema } from "@zcode/shared/zcode-protocol-v4";
import { analyzeWorkflowScript, holeSiteId } from "@zcode/dynamic-workflow";
import { boundGraphOfAnalysis } from "../src/tool/handlers/workflow-analysis-display.js";
import { createCreateWorkflowDisplay } from "../src/tool/executor/create-workflow-display.js";

for (const ok of [true, false]) {
  it(`FillWorkflowHole ${ok ? "success" : "rejection"} produces parseable metadata preserving fill and hole graph`, () => {
    const analysis = analyzeWorkflowScript(
      'phase("A");\nconst x = await hole<string>("outer", async () => {\n  phase("B");\n  return await files.read("README.md");\n});\nreturn await hole<string>("inner");',
    );
    assert.equal(analysis.ok, true, JSON.stringify(analysis.diagnostics));
    const causalityGraph = boundGraphOfAnalysis(analysis);
    assert.ok(causalityGraph);
    const fill = {
      siteId: holeSiteId("outer"),
      name: "outer",
      draftPath: "/draft/workflow.ts",
      line: 2,
    };
    const diagnostics = ok ? [] : [{ line: 2, column: 1, code: 1, message: "Denied" }];
    const output = { ok, response: ok ? "Filled" : "Denied", diagnostics, causalityGraph, fill };
    const before = structuredClone(output);
    const display = createCreateWorkflowDisplay(FILL_WORKFLOW_HOLE_TOOL_NAME, output);
    assert.deepEqual(display, {
      kind: "create_workflow",
      ok,
      errorCount: diagnostics.length,
      diagnostics,
      causalityGraph,
      fill,
    });
    const metadata = { schemaVersion: 1, display };
    // output 能过不代表 display 能过：落库与回放的 strict metadata 边界也必须保留 fill。
    assert.deepEqual(completedToolPartMetadataSchema.parse(metadata), metadata);
    assert.deepEqual(parseCompletedToolPartMetadata(metadata), metadata);
    assert.deepEqual(parseToolResultDisplayPayload(display), display);
    assert.deepEqual(toolCallCreateWorkflowDisplaySchema.parse(display), display);
    assert.deepEqual(output, before);
  });
}

it("CreateWorkflow/AmendWorkflow results without fill keep their legacy display shape", () => {
  for (const toolName of [CREATE_WORKFLOW_TOOL_NAME, AMEND_WORKFLOW_TOOL_NAME]) {
    const display = createCreateWorkflowDisplay(toolName, {
      ok: true,
      response: "OK",
      diagnostics: [],
    });
    assert.deepEqual(display, {
      kind: "create_workflow",
      ok: true,
      errorCount: 0,
      diagnostics: [],
    });
    assert.deepEqual(
      completedToolPartMetadataSchema.parse({ schemaVersion: 1, display }).display,
      display,
    );
  }
});

it("real analysis display preserves open nested holes and fill phase attribution", () => {
  const analysis = analyzeWorkflowScript(
    'phase("A");\nconst x = await hole<string>("outer", async () => {\n  phase("B");\n  const text = await files.read("README.md");\n  const y = await hole<string>("inner");\n  return y;\n});\nreturn x;',
  );
  assert.equal(analysis.ok, true, JSON.stringify(analysis.diagnostics));
  const graph = boundGraphOfAnalysis(analysis);
  assert.ok(graph);
  assert.equal(CreateWorkflowCausalityGraphSchema.safeParse(graph).success, true);
  assert.equal(graph.holes?.length, 1);
  assert.equal(graph.holes?.[0]?.siteId, holeSiteId("inner"));
  assert.equal(graph.holes?.[0]?.name, "inner");
  assert.equal(graph.phases?.find((phase) => phase.name === "B")?.fill, holeSiteId("outer"));
  assert.equal(graph.steps.find((step) => step.kind === "world-read")?.fill, holeSiteId("outer"));
});

it("strict display retains the main hole dependency handoffs and producer fill ownership", () => {
  const outer = holeSiteId("outer");
  const inner = holeSiteId("inner");
  const analysis = analyzeWorkflowScript(
    [
      'const worker = agent("worker");',
      'const result = await hole<string>("outer", async () => {',
      '  const text = await files.read("README.md");',
      '  return await hole<string>("inner", text);',
      "});",
      "return await worker.ask<string>(result);",
    ].join("\n"),
  );
  assert.equal(analysis.ok, true, JSON.stringify(analysis.diagnostics));
  const graph = boundGraphOfAnalysis(analysis);
  assert.ok(graph);
  const display = createCreateWorkflowDisplay(CREATE_WORKFLOW_TOOL_NAME, {
    ok: true,
    response: "OK",
    diagnostics: [],
    causalityGraph: graph,
  });
  assert.ok(display);
  assert.deepEqual(parseToolResultDisplayPayload(display), display);
  assert.deepEqual(toolCallCreateWorkflowDisplaySchema.parse(display), display);
  const read = graph.steps.find((step) => step.kind === "world-read");
  const hole = graph.steps.find((step) => step.id === inner);
  assert.equal(read?.fill, outer);
  assert.equal(hole?.kind, "hole");
  assert.equal(hole?.lane, "main");
  assert.equal(hole?.fill, outer);
  assert.ok(graph.lanes.some((lane) => lane.id === "main"));
  assert.ok(
    graph.handoffs?.some(
      (edge) =>
        edge.from.endsWith(":workspace") &&
        edge.to.endsWith(":main") &&
        edge.types?.includes("string"),
    ),
  );
});
