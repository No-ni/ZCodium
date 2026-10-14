import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDefaultSubagentPort } from "../src/runtime/methods/subagent.js";
import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/registry.js";
import type { AgentRuntimeDeps } from "../src/runtime/types.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";

test("default subagent waits for host workspace preparation before creating the child", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "zcodium-subagent-prepare-core-"));
  try {
    const seen: unknown[] = [];
    const guard = new Error("host workspace rejected");
    const runtime = {
      config: {
        workspacePath: "/conversation",
        subagents: { enabled: true, outputRootDir: outputRoot },
      },
      runtimeTaskRegistry: new InMemoryRuntimeTaskRegistry(),
      sessionId: "parent",
      enqueueBackgroundTaskNotification: () => {},
      notifyEventSinks: async () => {},
    } as unknown as AgentRuntimeInternal;
    const port = createDefaultSubagentPort.call(runtime, {
      prepareSubagentSession: async (input) => {
        seen.push(input);
        throw guard;
      },
    } as unknown as AgentRuntimeDeps);
    assert.ok(port);
    await assert.rejects(
      port.run({
        sessionId: "parent",
        agentType: "general-purpose",
        description: "fixture",
        prompt: "fixture",
        parentToolCallId: "fixture-tool",
        workingDirectory: "/conversation/2026-10-14/12345678/nested",
        workspaceRoot: "/conversation/2026-10-14/12345678",
        trace: { traceId: "fixture", spanId: "fixture" },
      }),
      (error) => error === guard,
    );
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], {
      sessionId: (seen[0] as { sessionId: string }).sessionId,
      resumeFromStore: false,
      workingDirectory: "/conversation/2026-10-14/12345678/nested",
      workspacePath: "/conversation",
      workspaceIdentity: undefined,
    });

    runtime.runtimeTaskRegistry.register({
      taskId: "fixture-agent",
      agentId: "fixture-agent",
      agentType: "general-purpose",
      childSessionId: "sess_subagent_persisted",
      description: "fixture",
      type: "local_agent",
      status: "completed",
      outputFile: join(outputRoot, "output.txt"),
      startedAt: new Date(),
    });
    const resumePort = createDefaultSubagentPort.call(runtime, {
      prepareSubagentSession: async (input) => {
        seen.push(input);
        throw guard;
      },
    } as unknown as AgentRuntimeDeps);
    await assert.rejects(
      resumePort!.sendMessage!({
        sessionId: "parent",
        to: "fixture-agent",
        message: "continue",
        summary: "continue",
        parentToolCallId: "fixture-resume-tool",
        workingDirectory: "/conversation/2026-10-14/12345678",
        workspaceRoot: "/conversation/2026-10-14/12345678",
        trace: { traceId: "fixture", spanId: "fixture" },
      }),
      (error) => error === guard,
    );
    await resumePort!.waitForTask!("fixture-agent");
    assert.equal(seen.length, 2);
    assert.equal((seen[1] as { resumeFromStore: boolean }).resumeFromStore, true);
    assert.equal((seen[1] as { sessionId: string }).sessionId, "sess_subagent_persisted");
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});
