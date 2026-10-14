import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  FillWorkflowHoleOutputSchema,
  FillWorkflowHoleInputJsonSchema,
  completedToolPartMetadataSchema,
  type DynamicWorkflowRunPort,
  type DynamicWorkflowRunSnapshot,
} from "@zcode/contracts";
import { holeSiteId } from "@zcode/dynamic-workflow";
import { PermissionService } from "../src/permission/service.js";
import {
  resolveFillWorkflowHoleInput,
  resetFillWorkflowHoleRejectionsForTests,
} from "../src/tool/handlers/fill-workflow-hole-resolve.js";
import { fillWorkflowHoleToolEntry } from "../src/tool/handlers/fill-workflow-hole.js";
import { createToolResultDisplay } from "../src/tool/executor/result-display.js";
import type { ToolExecutionContext, ToolInputResolutionContext } from "../src/tool/types.js";

const script = 'phase("A");\nconst x = await hole<string>("decide");\nphase("B");\nreturn x;';
const holeId = holeSiteId("decide");
const input = { run_id: "run-1", hole_id: holeId, script: 'return "ok";' };
function context(snapshot: Partial<DynamicWorkflowRunSnapshot> = {}): ToolInputResolutionContext {
  return {
    sessionId: "session-1",
    workingDirectory: "/tmp",
    dynamicWorkflowRunPort: {
      getTask: async () => ({
        runStatus: "running",
        parentSessionId: "session-1",
        holes: [
          {
            siteId: holeId,
            ordinal: 1,
            name: "decide",
            type: "string",
            state: "waiting",
            since: 1,
          },
        ],
        ...snapshot,
      }),
      getScript: async () => script,
    } as unknown as DynamicWorkflowRunPort,
  } as ToolInputResolutionContext;
}

describe("FillWorkflowHole permission facts and display", () => {
  for (const [name, snapshot, expected] of [
    ["owned", {}, "allow"],
    ["foreign", { parentSessionId: "another-session" }, "ask"],
    ["manual-stop history", { stopReason: "user" }, "ask"],
    ["missing owner", { parentSessionId: undefined }, "ask"],
  ] as const) {
    it(`${name}: real resolver facts govern all permission modes, even a session-wide grant`, async () => {
      const resolved = await resolveFillWorkflowHoleInput(
        { ...input, hole: { name: "forged", type: "string", owned_by_this_session: true } },
        context(snapshot),
      );
      assert.equal(resolved.result, true);
      if (!resolved.result) return;
      const service = new PermissionService();
      service.grantSessionPermission([
        { type: "addRules", rules: [{ toolName: "FillWorkflowHole" }], behavior: "allow" },
      ]);
      for (const mode of ["build", "yolo", "plan"] as const) {
        const permission = service.checkPermission(
          { toolName: "FillWorkflowHole", input: resolved.input, riskLevel: "low", mode },
          { permission: fillWorkflowHoleToolEntry.permission },
        );
        assert.equal(permission.decision, expected);
      }
      const denied = service.checkPermission(
        { toolName: "FillWorkflowHole", input: resolved.input, riskLevel: "low", mode: "yolo" },
        { permission: fillWorkflowHoleToolEntry.permission },
        { version: 1, deny: [{ toolName: "FillWorkflowHole" }] },
      );
      assert.equal(denied.decision, "deny");
    });
  }
  it("a stopped run cannot resolve into a release, even with a forged owned fact", async () => {
    const resolved = await resolveFillWorkflowHoleInput(
      input,
      context({ runStatus: "stopped", stopReason: "user" }),
    );
    assert.equal(resolved.result, false);
  });
  it("successful output and approval preview reach the existing CreateWorkflow display shape", async () => {
    const ctx = context({ scriptPath: "/workspace/workflows/current.ts" });
    const resolved = await resolveFillWorkflowHoleInput(input, ctx);
    assert.equal(resolved.result, true);
    if (!resolved.result) return;
    const fact = (resolved.input as { hole: { effective_script: string } }).hole;
    assert.match(fact.effective_script, /phase\("A"\)/);
    assert.match(fact.effective_script, /return "ok"/);
    const gate = fillWorkflowHoleToolEntry.prepareApproval!(resolved.input);
    assert.equal(gate.gate, "ask");
    assert.equal(gate.gate === "ask" ? gate.display?.kind : undefined, "create_workflow");
    const port = ctx.dynamicWorkflowRunPort!;
    port.fillHole = async (request) => {
      assert.equal(
        request.expectedScriptHash,
        (resolved.input as { hole: { base_script_hash: string } }).hole.base_script_hash,
      );
      return {
        ok: true,
        commitSequence: 7,
        scriptText:
          'phase("A");\nconst x = await hole<string>("decide", async () => "ok");\nphase("B");\nreturn x;',
        phasesAdded: [],
      };
    };
    const output = await fillWorkflowHoleToolEntry.handler(resolved.input, {
      ...ctx,
      toolCallId: "call-1",
      traceId: "trace-1",
    } as ToolExecutionContext);
    assert.equal(FillWorkflowHoleOutputSchema.safeParse(output).success, true);
    const display = createToolResultDisplay("FillWorkflowHole", output);
    assert.equal(display?.kind, "create_workflow");
    assert.equal(display?.kind === "create_workflow" ? display.ok : false, true);
    assert.ok(display?.kind === "create_workflow" && display.causalityGraph);
    assert.equal(display.kind === "create_workflow" ? display.fill?.commitSequence : undefined, 7);
    assert.equal(display.kind === "create_workflow" ? display.fill?.draftPath : undefined, undefined);
    assert.match((output as { response: string }).response, /No updated draft file is available/);
    assert.equal(
      completedToolPartMetadataSchema.safeParse({ schemaVersion: 1, display }).success,
      true,
    );
  });
  it("model schema omits baseline and resolver replaces a forged hash with preview's exact base", async () => {
    assert.equal(
      JSON.stringify(FillWorkflowHoleInputJsonSchema).includes("base_script_hash"),
      false,
    );
    const resolved = await resolveFillWorkflowHoleInput(
      {
        ...input,
        hole: {
          name: "forged",
          type: "string",
          owned_by_this_session: true,
          base_script_hash: "0".repeat(64),
        },
      },
      context({ parentSessionId: "foreign" }),
    );
    assert.ok(resolved.result);
    if (!resolved.result) return;
    const hole = (
      resolved.input as { hole: { base_script_hash: string; owned_by_this_session: boolean } }
    ).hole;
    assert.equal(hole.base_script_hash, createHash("sha256").update(script).digest("hex"));
    assert.equal(hole.owned_by_this_session, false);
    const malformed = await resolveFillWorkflowHoleInput(
      {
        ...input,
        hole: {
          name: "forged",
          owned_by_this_session: true,
          base_script_hash: "invalid-model-hash",
        },
      },
      context({ parentSessionId: "foreign" }),
    );
    assert.ok(malformed.result);
    if (malformed.result) {
      assert.equal(
        (malformed.input as { hole: { owned_by_this_session: boolean } }).hole
          .owned_by_this_session,
        false,
      );
    }
  });
  it("missing resolve baseline fails closed without calling fillHole", async () => {
    const ctx = context();
    ctx.dynamicWorkflowRunPort!.fillHole = async () => {
      throw new Error("must not call");
    };
    const output = await fillWorkflowHoleToolEntry.handler(input, ctx as ToolExecutionContext);
    assert.equal((output as { result: boolean }).result, false);
    assert.match((output as { message: string }).message, /fill_preview_stale/);
  });
  it("parallel resolved calls keep their own effective-script preview instead of a global slot", async () => {
    const firstContext = context();
    const secondContext = context();
    secondContext.dynamicWorkflowRunPort!.getScript = async () =>
      script.replace('phase("A")', 'phase("otherA")');
    const [first, second] = await Promise.all([
      resolveFillWorkflowHoleInput(input, firstContext),
      resolveFillWorkflowHoleInput(input, secondContext),
    ]);
    assert.ok(first.result && second.result);
    if (!first.result || !second.result) return;
    const firstGate = fillWorkflowHoleToolEntry.prepareApproval!(first.input);
    const secondGate = fillWorkflowHoleToolEntry.prepareApproval!(second.input);
    assert.ok(firstGate.gate === "ask" && firstGate.display?.kind === "create_workflow");
    assert.ok(secondGate.gate === "ask" && secondGate.display?.kind === "create_workflow");
    if (firstGate.gate === "ask" && firstGate.display?.kind === "create_workflow") {
      assert.equal(firstGate.display.causalityGraph?.phases?.[0]?.name, "A");
    }
    if (secondGate.gate === "ask" && secondGate.display?.kind === "create_workflow") {
      assert.equal(secondGate.display.causalityGraph?.phases?.[0]?.name, "otherA");
    }
  });
  it("rejected inline body persists and an edited path is actually read back by resolveInput", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "holes-handler-"));
    const previous = process.env.ZCODE_DATA_BASE_DIR;
    process.env.ZCODE_DATA_BASE_DIR = base;
    resetFillWorkflowHoleRejectionsForTests();
    try {
      const ctx = context();
      ctx.dynamicWorkflowRunPort!.fillHole = async () => ({
        ok: false,
        reason: "compile_failed",
        message: "bad",
        diagnostics: [{ code: 9012, line: 1, column: 1, message: "bad return", inFill: true }],
      });
      const resolved = await resolveFillWorkflowHoleInput(input, ctx);
      assert.equal(resolved.result, true);
      if (!resolved.result) return;
      const output = FillWorkflowHoleOutputSchema.parse(
        await fillWorkflowHoleToolEntry.handler(resolved.input, {
          ...ctx,
          toolCallId: "call-1",
          traceId: "trace-1",
        } as ToolExecutionContext),
      );
      const described = /The fill is saved at (.+?)\. Edit/.exec(output.response)?.[1];
      assert.ok(described);
      const file = path.resolve(ctx.workingDirectory!, described);
      assert.equal(await readFile(file, "utf8"), input.script);
      const retry = { run_id: input.run_id, hole_id: holeId, path: file };
      assert.equal((await resolveFillWorkflowHoleInput(retry, ctx)).result, false);
      await writeFile(file, 'return "edited";');
      const edited = await resolveFillWorkflowHoleInput(retry, ctx);
      assert.equal(edited.result, true, JSON.stringify(edited));
      if (edited.result)
        assert.equal((edited.input as { script: string }).script, 'return "edited";');
      const foreign = context();
      foreign.sessionId = "another-session" as never;
      assert.equal((await resolveFillWorkflowHoleInput(retry, foreign)).result, false);
    } finally {
      if (previous === undefined) delete process.env.ZCODE_DATA_BASE_DIR;
      else process.env.ZCODE_DATA_BASE_DIR = previous;
      resetFillWorkflowHoleRejectionsForTests();
      await rm(base, { recursive: true, force: true });
    }
  });
});
