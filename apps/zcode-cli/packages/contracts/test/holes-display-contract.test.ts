import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  backgroundResultOriginMetaSchema,
  toolCallCreateWorkflowDisplaySchema,
  workflowNotificationMetaSchema,
} from "@zcode/shared/zcode-protocol-v4";
import {
  CreateWorkflowOutputSchema,
  CreateWorkflowCausalityGraphSchema,
} from "../src/tools/create-workflow.js";
import {
  FillWorkflowHoleHoleSchema,
  FillWorkflowHoleOutputSchema,
} from "../src/tools/fill-workflow-hole.js";
import {
  completedToolPartMetadataSchema,
  parseCompletedToolPartMetadata,
  parseToolResultDisplayPayload,
} from "../src/tools/tool-result-metadata.js";
import type { WorkflowNotificationMeta } from "../src/events/session.events.js";

const siteId = "hole#1234abcd";
const fill = { siteId, name: "Decide", draftPath: "/draft/workflow.ts", line: 2 };
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
const display = {
  kind: "create_workflow",
  ok: true,
  errorCount: 0,
  diagnostics: [],
  causalityGraph: graph,
  fill,
};

function acceptsFill(value: unknown): boolean[] {
  return [
    CreateWorkflowOutputSchema.safeParse({
      ok: true,
      response: "Result",
      diagnostics: [],
      fill: value,
    }).success,
    completedToolPartMetadataSchema.safeParse({
      schemaVersion: 1,
      display: { ...display, fill: value },
    }).success,
    toolCallCreateWorkflowDisplaySchema.safeParse({ ...display, fill: value }).success,
  ];
}

describe("holes display producer contract", () => {
  it("durable commit sequence reuses output fill schema at strict producer metadata boundary", () => {
    const committedFill = { ...fill, commitSequence: 0 };
    assert.equal(
      CreateWorkflowOutputSchema.safeParse({
        ok: true,
        response: "filled",
        diagnostics: [],
        fill: committedFill,
      }).success,
      true,
    );
    assert.equal(
      completedToolPartMetadataSchema.safeParse({
        schemaVersion: 1,
        display: { ...display, fill: committedFill },
      }).success,
      true,
    );
    for (const commitSequence of [-1, 1.5, "1"]) {
      assert.equal(
        CreateWorkflowOutputSchema.safeParse({
          ok: true,
          response: "filled",
          diagnostics: [],
          fill: { ...fill, commitSequence },
        }).success,
        false,
      );
      assert.equal(
        completedToolPartMetadataSchema.safeParse({
          schemaVersion: 1,
          display: { ...display, fill: { ...fill, commitSequence } },
        }).success,
        false,
      );
    }
    assert.equal(
      FillWorkflowHoleHoleSchema.safeParse({
        name: "A",
        type: "string",
        owned_by_this_session: false,
        base_script_hash: "bad",
      }).success,
      false,
    );
  });
  it("lets backend produce kind:hole graph with holes at graph level", () => {
    assert.deepEqual(CreateWorkflowCausalityGraphSchema.parse(graph), graph);
    assert.equal(FillWorkflowHoleOutputSchema, CreateWorkflowOutputSchema);
    for (const ok of [true, false]) {
      assert.equal(
        CreateWorkflowOutputSchema.safeParse({
          ok,
          response: "Result",
          diagnostics: [],
          causalityGraph: graph,
          fill,
        }).success,
        true,
      );
      const metadata = { schemaVersion: 1, display: { ...display, ok } };
      assert.deepEqual(completedToolPartMetadataSchema.parse(metadata), metadata);
      assert.deepEqual(parseCompletedToolPartMetadata(metadata), metadata);
      assert.deepEqual(parseToolResultDisplayPayload(metadata.display), metadata.display);
      assert.deepEqual(
        toolCallCreateWorkflowDisplaySchema.parse(metadata.display),
        metadata.display,
      );
    }
  });

  it("keeps identical strict fill limits at output, producer metadata and shared display boundaries", () => {
    for (const value of [
      { siteId: "x", name: "x" },
      { siteId: "x".repeat(64), name: "x".repeat(128), draftPath: "x".repeat(1024), line: 1 },
    ]) {
      assert.deepEqual(acceptsFill(value), [true, true, true]);
    }
    for (const value of [
      { ...fill, siteId: "" },
      { ...fill, siteId: "x".repeat(65) },
      { ...fill, name: "" },
      { ...fill, name: "x".repeat(129) },
      { ...fill, draftPath: "" },
      { ...fill, draftPath: "x".repeat(1025) },
      { ...fill, line: 0 },
      { ...fill, line: 1.5 },
      { ...fill, unexpected: true },
      { name: fill.name },
      { siteId },
    ]) {
      assert.deepEqual(acceptsFill(value), [false, false, false]);
      assert.equal(
        parseCompletedToolPartMetadata({ schemaVersion: 1, display: { ...display, fill: value } }),
        undefined,
      );
    }
    assert.equal(
      parseCompletedToolPartMetadata({
        schemaVersion: 1,
        display: { ...display, unexpected: true },
      }),
      undefined,
    );
  });

  it("allows resolved effective preview and validates typed hole manifests through session metadata", () => {
    assert.equal(
      FillWorkflowHoleHoleSchema.safeParse({
        name: "Decide",
        type: "string",
        owned_by_this_session: false,
        effective_script: "return hole<string>('Decide', () => 'yes');",
      }).success,
      true,
    );
    const manifest: WorkflowNotificationMeta = {
      kind: "hole",
      siteId,
      ordinal: 0,
      name: "Decide",
      type: "string",
      prompt: "Choose a value",
      draftPath: "/draft/workflow.ts",
      line: 2,
      before: "Start",
      after: "Finish",
      reachedAt: 123,
    };
    const originMeta = {
      backgroundSource: "workflow",
      workId: "run-1",
      title: "Hole reached",
      workflowNotification: manifest,
    };
    assert.deepEqual(workflowNotificationMetaSchema.parse(manifest), manifest);
    assert.deepEqual(backgroundResultOriginMetaSchema.parse(originMeta), originMeta);
    for (const patch of [
      { siteId: undefined },
      { ordinal: undefined },
      { name: undefined },
      { type: undefined },
      { siteId: "" },
      { siteId: "x".repeat(65) },
      { ordinal: -1 },
      { ordinal: 1.5 },
      { name: "x".repeat(129) },
      { type: "x".repeat(129) },
      { prompt: "x".repeat(4001) },
      { draftPath: "x".repeat(1025) },
      { line: 0 },
      { line: 1.5 },
      { before: "x".repeat(129) },
      { after: "x".repeat(129) },
      { reachedAt: "123" },
    ]) {
      const workflowNotification = { ...manifest, ...patch };
      assert.equal(workflowNotificationMetaSchema.safeParse(workflowNotification).success, false);
      assert.equal(
        backgroundResultOriginMetaSchema.safeParse({ ...originMeta, workflowNotification }).success,
        false,
      );
    }
    const boundedManifest = {
      ...manifest,
      siteId: "x".repeat(64),
      name: "x".repeat(128),
      type: "x".repeat(128),
      prompt: "x".repeat(4000),
      draftPath: "x".repeat(1024),
      before: "x".repeat(128),
      after: "x".repeat(128),
    };
    assert.deepEqual(
      backgroundResultOriginMetaSchema.parse({
        ...originMeta,
        workflowNotification: boundedManifest,
      }).workflowNotification,
      boundedManifest,
    );
    const emptyOptionalText = { ...manifest, prompt: "", draftPath: "", before: "", after: "" };
    assert.deepEqual(workflowNotificationMetaSchema.parse(emptyOptionalText), emptyOptionalText);
  });
});
