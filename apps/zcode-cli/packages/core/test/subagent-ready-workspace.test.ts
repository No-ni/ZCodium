import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSessionId, SessionEventType, type SessionEvent } from "@zcode/contracts";
import { createExploreSubagentPort } from "../src/subagent/runner.js";
import { notifyEventSinks } from "../src/runtime/methods/events.js";
import { notifyExternalChildSessionEvent } from "../src/runtime/methods/config.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";

test("external child event forwards its cwd without replacing it with the parent's cwd", async () => {
  const seen: string[] = [];
  const parent = {
    workingDirectory: "parent-cwd",
    rootTraceContext: {},
    eventSinks: new Set([
      {
        onSessionEvent: (_event: SessionEvent, cwd?: string) => {
          seen.push(cwd!);
        },
      },
    ]),
    notifyEventSinks,
  } as unknown as AgentRuntimeInternal;
  await notifyExternalChildSessionEvent.call(parent, {
    childSessionId: createSessionId("fixture-child"),
    executionWorkspacePath: "child-cwd",
    event: { sessionId: "fixture-child" } as SessionEvent,
  });
  assert.deepEqual(seen, ["child-cwd"]);
});

test("subagent readiness preserves actual child cwd through foreground, background and terminal resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcodium-child-ready-"));
  const events: SessionEvent[] = [];
  const childCwd = join(root, "child-persisted");
  let agentNumber = 0;
  const port = createExploreSubagentPort({
    outputRootDir: root,
    createAgentId: () => `agent-${++agentNumber}`,
    emitParentEvent: async (event) => {
      events.push(event);
    },
    runExploreAgent: async (request) => {
      // 模拟恢复所有者已从持久化行裁决 cwd；父 SendMessage 请求中的目录不能覆盖它。
      await request.onSessionReady?.(childCwd);
      return { response: "done", traceId: request.traceContext.traceId, events: [] };
    },
  });
  const request = {
    sessionId: createSessionId("ready-parent"),
    agentType: "general-purpose",
    description: "fixture",
    prompt: "fixture",
    parentToolCallId: "ready-call",
    workingDirectory: join(root, "parent-new-cwd"),
    workspaceRoot: root,
    trace: { traceId: "ready-trace", spanId: "ready-span" },
  };
  try {
    const foreground = await port.run(request);
    assert.equal(foreground.status, "completed");
    const background = await port.start!(request);
    await port.waitForTask!(background.agentId);
    const resumed = await port.sendMessage!({
      ...request,
      to: foreground.agentId,
      summary: "continue",
      message: "continue",
    });
    assert.equal(resumed.delivery, "resumed_background");
    await port.waitForTask!(foreground.agentId);
    const spawned = events.filter((event) => event.type === SessionEventType.SubagentSpawned);
    assert.equal(spawned.length, 3);
    assert.ok(
      spawned.every(
        (event) =>
          (event.payload as { childExecutionWorkspacePath?: string })
            .childExecutionWorkspacePath === childCwd,
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy subagent readiness without cwd falls back to its launch request", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcodium-child-ready-legacy-"));
  let spawnedPath: string | undefined;
  const port = createExploreSubagentPort({
    outputRootDir: root,
    emitParentEvent: async (event) => {
      if (event.type === SessionEventType.SubagentSpawned) {
        spawnedPath = (event.payload as { childExecutionWorkspacePath?: string })
          .childExecutionWorkspacePath;
      }
    },
    runExploreAgent: async (request) => ({
      response: "done",
      traceId: request.traceContext.traceId,
      events: [],
    }),
  });
  try {
    await port.run({
      sessionId: createSessionId("legacy-parent"),
      agentType: "general-purpose",
      description: "fixture",
      prompt: "fixture",
      parentToolCallId: "legacy-call",
      workingDirectory: root,
      workspaceRoot: root,
      trace: { traceId: "legacy-trace", spanId: "legacy-span" },
    });
    assert.equal(spawnedPath, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
