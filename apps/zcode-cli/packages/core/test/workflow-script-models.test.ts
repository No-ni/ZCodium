import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import type { ModelCatalogPort, ToolCallId } from "@zcode/contracts";
import {
  CreateWorkflowInputJsonSchema,
  AmendWorkflowInputJsonSchema,
  FillWorkflowHoleInputJsonSchema,
} from "@zcode/contracts";
import { resolveCreateWorkflowInput } from "../src/tool/handlers/create-workflow-source.js";
import { createWorkflowToolEntry } from "../src/tool/handlers/create-workflow.js";
import {
  bindScriptModels,
  readScriptModelBindings,
  withScriptModelBindings,
} from "../src/tool/handlers/workflow-script-models.js";
import { analyzeScript } from "../src/tool/handlers/workflow-script-analysis.js";
import type { ToolExecutionContext } from "../src/tool/types.js";

const script = 'const a = agent("worker", { model: "fast" }); return await a.ask("hello");';
const catalog: ModelCatalogPort = {
  listModels: () => [
    {
      providerId: "p",
      modelId: "fast",
      current: false,
      reasoningLevels: ["high"],
      defaultReasoningLevel: "high",
    },
  ],
};

it("host bindings are absent from model schemas and malformed forged bindings are overwritten", async () => {
  for (const schema of [
    CreateWorkflowInputJsonSchema,
    AmendWorkflowInputJsonSchema,
    FillWorkflowHoleInputJsonSchema,
  ]) {
    assert.equal(Object.hasOwn(schema.properties ?? {}, "model_bindings"), false);
  }
  const resolved = await resolveCreateWorkflowInput(
    { script, model_bindings: false },
    { executionCwd: ".", workspaceDirectory: "." },
    undefined,
    catalog,
  );
  assert.equal(resolved.result, true);
  if (!resolved.result) return;
  assert.deepEqual({ ...readScriptModelBindings(resolved.input) }, { fast: "p/fast$high" });
  const noModels = withScriptModelBindings(
    { script: "return 1;", model_bindings: { fast: "evil/model" } },
    catalog,
  );
  assert.equal(Object.hasOwn(noModels, "model_bindings"), false);
});

it("unknown, ambiguous, disabled and illegal reasoning models return 9011", () => {
  for (const entries of [
    [],
    [
      {
        providerId: "p",
        modelId: "fast",
        current: false,
        reasoningLevels: [],
        disabledReason: "disabled",
      },
    ],
    [
      { providerId: "p", modelId: "fast", current: false, reasoningLevels: [] },
      { providerId: "q", modelId: "fast", current: false, reasoningLevels: [] },
    ],
  ]) {
    const bound = bindScriptModels(analyzeScript(script), { listModels: () => entries });
    assert.equal(bound.unbound[0]?.code, 9011);
    assert.equal(bound.selections, undefined);
  }
  assert.equal(
    bindScriptModels(analyzeScript(script.replace('"fast"', '"fast$bogus"')), catalog).unbound[0]
      ?.code,
    9011,
  );
});

it("9011 skips approval and leaves run, draft and storage untouched", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "workflow-models-"));
  let submitted = 0;
  try {
    const resolution = await resolveCreateWorkflowInput(
      { script, model_bindings: { fast: "p/forged" } },
      { executionCwd: cwd, workspaceDirectory: cwd },
      undefined,
      { listModels: () => [] },
    );
    assert.equal(resolution.result, true);
    if (!resolution.result) return;
    const gate = await createWorkflowToolEntry.prepareApproval!(resolution.input, {} as never);
    assert.equal(gate.gate, "proceed");
    const output = await createWorkflowToolEntry.handler(resolution.input, {
      workingDirectory: cwd,
      workspaceScopeRoot: cwd,
      dynamicWorkflowRunPort: {
        submit: () => {
          submitted++;
          throw new Error("must not submit");
        },
      },
      modelCatalogPort: { listModels: () => [] },
      toolCallId: "tool-test" as ToolCallId,
    } as unknown as ToolExecutionContext);
    assert.equal((output as { ok: boolean }).ok, false);
    assert.equal(submitted, 0);
    assert.deepEqual(await readdir(cwd), []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it("model names matching Object prototype members still require explicit bindings", () => {
  const analysis = analyzeScript('agent("a", { model: "toString" });');
  const bound = bindScriptModels(analysis, { listModels: () => [] });
  assert.equal(bound.unbound[0]?.code, 9011);
});
