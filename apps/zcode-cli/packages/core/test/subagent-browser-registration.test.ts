import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentRuntimeDeps } from "../src/runtime/types.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/registry.js";
import { createDefaultSubagentPort } from "../src/runtime/methods/subagent.js";

describe("subagent browser registration", () => {
  it("撤销 child runtime 构造失败时的父会话登记", async () => {
    let registeredChildSessionId: string | undefined;
    const closedSessionIds: string[] = [];
    const browserControlPort = {
      forChildSession: ({ childSessionId }: { childSessionId: string }) => {
        registeredChildSessionId = childSessionId;
        return {
          closeSession: async ({ sessionId }: { sessionId: string }) => {
            closedSessionIds.push(sessionId);
          },
        };
      },
    };
    const logger = {
      child: () => {
        throw new Error("fixture child logger failure");
      },
      debug: () => {},
      info: () => {},
      warn: () => {},
    };
    const model = {
      modelId: "fixture-model",
      options: {},
      providerId: "fixture-provider",
    };
    const modelFactory = () => model;
    const runtime = {
      browserControlPort,
      config: { mode: "build", subagents: { enabled: true }, workspacePath: "/workspace" },
      enqueueBackgroundTaskNotification: () => {},
      enqueueSubagentMessage: () => {},
      getPlanEnabled: () => false,
      getSessionModelSelection: () => ({ modelId: model.modelId, providerId: model.providerId }),
      getTools: () => [],
      logger,
      modelFactory,
      notifyEventSinks: async () => {},
      runtimeTaskRegistry: new InMemoryRuntimeTaskRegistry(),
      sessionId: "parent-session",
      workingDirectory: "/workspace",
      workspaceRoot: "/workspace",
    } as unknown as AgentRuntimeInternal;
    const deps = {
      eventStore: {},
      modelFactory,
    } as unknown as AgentRuntimeDeps;
    const port = createDefaultSubagentPort.call(runtime, deps);
    assert.ok(port);

    await assert.rejects(
      port.run({
        agentType: "general-purpose",
        description: "fixture",
        parentToolCallId: "tool-call",
        prompt: "run",
        sessionId: "parent-session",
        trace: { traceId: "trace", spanId: "parent-span" },
        workingDirectory: "/workspace",
        workspaceRoot: "/workspace",
      }),
      /fixture child logger failure/,
    );

    assert.ok(registeredChildSessionId);
    assert.deepEqual(closedSessionIds, [registeredChildSessionId]);
  });
});
