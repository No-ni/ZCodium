import assert from "node:assert/strict";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { z } from "zod";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import {
  InMemorySessionEventStore,
  SessionEventType,
  createSessionId,
  type MessageWithParts,
  type SessionEvent,
  type ToolPart,
} from "@zcode/contracts";
import {
  createRecommendedNativeContextConfiguration,
  nativeContextStatusSchema,
} from "@zcode/shared/native-context-compression";
import {
  assertProjectPath,
  createProjectTestFixture,
} from "../../../../../scripts/ci/project-test-sandbox.mjs";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { historyVersionOf } from "../src/runtime/native-context-compression/identity.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { ToolEntry } from "../src/tool/types.js";
import {
  batchDeferred,
  createNctxBatchModels,
  NCTX_BATCH_MAIN,
  NCTX_BATCH_CALL_IDS,
  NCTX_BATCH_MAINTENANCE,
  NCTX_BATCH_TOOL_NAMES,
  NCTX_BATCH_OLD_TEXT,
} from "./native-context-tool-batch-model.js";

export function nctxBatchToolParts(messages: readonly MessageWithParts[]): ToolPart[] {
  return messages.flatMap((message) =>
    message.parts.filter((part): part is ToolPart => part.type === "tool"),
  );
}

/** 真实 typed 工具，只有 handler 的合成结果受 gate 控制；不替换 executor 或 batch lifecycle。 */
export function nctxBatchToolEntry(
  index: 0 | 1,
  gate: {
    entered: ReturnType<typeof batchDeferred>;
    release: ReturnType<typeof batchDeferred>;
  },
  order: string[],
): ToolEntry {
  const slot = index === 0 ? "first" : "second";
  const schema = z.object({ slot: z.literal(slot) }).strict();
  return {
    capability: "Return one synthetic read-only observation after the test gate opens",
    metadata: {
      name: NCTX_BATCH_TOOL_NAMES[index],
      description: "Synthetic batch read-only fixture",
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      sideEffectScope: "none",
      riskLevel: "low",
      needsApproval: false,
    },
    inputSchema: {
      type: "object",
      properties: { slot: { type: "string", enum: [slot] } },
      required: ["slot"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { slot: { type: "string" }, observation: { type: "string" } },
      required: ["slot", "observation"],
      additionalProperties: false,
    },
    runtimeInputSchema: schema,
    permission: {
      permission: "nctxBatchFixture",
      reason: "Read-only synthetic test result",
      riskLevel: "low",
      sideEffectScope: "none",
      needsApproval: false,
      patternSources: ["toolName"],
      denyPriority: "beforeAsk",
    },
    resultBudget: { maxInlineBytes: 4096, maxModelBytes: 4096, strategy: "truncate" },
    timeout: { kind: "none" },
    cancellation: {
      supported: true,
      cleanup: "none",
      userVisibleMessage: "Synthetic batch cancelled",
    },
    trace: {
      required: true,
      propagateToAdapters: false,
      recordInput: "summary",
      recordOutput: "summary",
    },
    async handler(input, context) {
      assert.deepEqual(schema.parse(input), { slot });
      assert.equal(context.abortSignal.aborted, false);
      assert.equal(context.toolCallId, NCTX_BATCH_CALL_IDS[index]);
      order.push(`tool-${slot}-entered`);
      gate.entered.resolve();
      await gate.release.promise;
      context.abortSignal.throwIfAborted();
      order.push(`tool-${slot}-returned`);
      return { slot, observation: `Synthetic ${slot} observation completed.` };
    },
  };
}

export async function createNctxToolBatchFixture(t: TestContext) {
  const directory = await createProjectTestFixture("nctx-real-tool-batch");
  const dbPath = await assertProjectPath(join(directory, "batch.sqlite"));
  const store = await createSqliteSessionStore({ dbPath });
  const sessionId = createSessionId("nctx-real-tool-batch");
  const order: string[] = [];
  const events: SessionEvent[] = [];
  const gates = [0, 1].map(() => ({ entered: batchDeferred(), release: batchDeferred() }));
  const finalEntered = batchDeferred(),
    finalRelease = batchDeferred();
  const maintenanceEntered = batchDeferred(),
    maintenanceRelease = batchDeferred();
  const firstResult = batchDeferred(),
    maintenanceSettled = batchDeferred();
  let runtime!: AgentRuntime;
  let completedHistoryVersion: string | undefined;
  let maintenanceHistoryVersion: string | undefined;
  let finalMessages: MessageWithParts[] = [];
  let maintenanceMessages: MessageWithParts[] = [];
  let mainTurn: Promise<unknown> | undefined;
  const drains: Promise<void>[] = [];
  const registry = createToolRegistry();
  registry.register(nctxBatchToolEntry(0, gates[0]!, order));
  registry.register(nctxBatchToolEntry(1, gates[1]!, order));
  const models = createNctxBatchModels({
    finalEntered,
    finalRelease,
    maintenanceEntered,
    maintenanceRelease,
    order,
    onFinal: async () => {
      finalMessages = await store.messages({ sessionID: sessionId });
      assert.deepEqual(
        nctxBatchToolParts(finalMessages).map((part) => part.state.status),
        ["completed", "completed"],
      );
    },
    onMaintenance: async () => {
      const internal = runtime as unknown as AgentRuntimeInternal;
      maintenanceMessages = await store.messages({ sessionID: sessionId });
      const assistant = maintenanceMessages.at(-1)!;
      assert.equal(assistant.info.role, "assistant");
      assert.ok(assistant.info.time.completed);
      assert.ok(assistant.parts.some((part) => part.type === "step-finish"));
      completedHistoryVersion = historyVersionOf(
        internal.messageHistory.borrowReadOnlyRuntimeEntries(),
      );
      maintenanceHistoryVersion = (await store.getNativeContextState(sessionId))!.historyVersion;
      assert.equal(maintenanceHistoryVersion, completedHistoryVersion);
    },
  });
  const configuration = createRecommendedNativeContextConfiguration("manual");
  configuration.parameters.history.preserveTurns = 0;
  configuration.parameters.history.preserveMessages = 0;
  configuration.parameters.history.preserveTokens = 0;
  configuration.parameters.summary.minRangeChars = 1;
  configuration.parameters.summary.minChars = 16;
  configuration.parameters.trigger.minBenefitTokens = 0;
  runtime = new AgentRuntime(
    sessionId,
    {
      workingDirectory: directory,
      workspacePath: directory,
      mode: "build",
      taskType: "interactive",
      modelSelection: NCTX_BATCH_MAIN,
      modelStreaming: "off",
      streamingToolExecution: "off",
      titleGeneration: { enabled: false },
      memory: { enabled: false },
      mcp: { enabled: false, servers: {} },
      subagents: { enabled: false },
      toolSearch: { mode: "off" },
      toolAllowlist: NCTX_BATCH_TOOL_NAMES,
      toolConcurrency: { maxConcurrency: 2 },
      nativeContextCompression: configuration,
      envInfo: {
        cwd: directory,
        platform: process.platform,
        shell: "pwsh",
        osVersion: "synthetic-test",
        nodeVersion: process.version,
        isGitRepository: false,
      },
    },
    {
      sessionStore: store,
      eventStore: new InMemorySessionEventStore(),
      fileSystemPort: createNodeFileSystemAdapter(),
      toolRegistry: registry,
      modelFactory: models.factory,
      eventSink: {
        onSessionEvent(event) {
          events.push(event);
          if (
            event.type === SessionEventType.ToolCallResult &&
            (event.payload as { toolCallId: string }).toolCallId === NCTX_BATCH_CALL_IDS[0]
          )
            firstResult.resolve();
          if (event.type === SessionEventType.TurnComplete) order.push("main-complete");
          if (event.type === SessionEventType.NativeContextCompressionUpdated) {
            const parsed = nativeContextStatusSchema.parse(event.payload);
            if (parsed.phase === "idle" && parsed.lastOperation?.status === "completed")
              maintenanceSettled.resolve();
          }
        },
      },
    },
  );
  const internal = runtime as unknown as AgentRuntimeInternal;
  const actualDrain = internal.drainRuntimeCommandQueue;
  // 状态 idle 事件早于 runRuntimeCommand 的 finally；只保留原函数的 Promise 作为观察屏障，
  // 不另调 drain、不改队列和完成顺序，避免用延时或事件提前断言前台已经释放。
  internal.drainRuntimeCommandQueue = function () {
    const drain = actualDrain.call(this);
    drains.push(drain);
    return drain;
  };
  t.after(async () => {
    gates.forEach((gate) => gate.release.resolve());
    finalRelease.resolve();
    maintenanceRelease.resolve();
    if (mainTurn) await Promise.allSettled([mainTurn]);
    await Promise.allSettled(drains);
    await runtime.close();
    await store.close();
  });
  await runtime.executeTurn(NCTX_BATCH_OLD_TEXT);
  assert.equal(
    (await store.listNativeContextObservations(sessionId, { purpose: "maintenance" })).items.length,
    0,
  );
  const initialMessages = await store.messages({ sessionID: sessionId });
  const startMain = () => {
    mainTurn = runtime.executeTurn(
      "NCTX09_REAL_TOOL_BATCH: collect both synthetic observations and answer.",
    );
    return mainTurn;
  };
  const input = {
    model: NCTX_BATCH_MAINTENANCE,
    commandId: "nctx-batch-manual-command",
    abortSignal: new AbortController().signal,
    traceContext: (runtime as unknown as AgentRuntimeInternal).rootTraceContext,
  };
  return {
    runtime,
    store,
    sessionId,
    order,
    events,
    gates,
    finalEntered,
    finalRelease,
    maintenanceEntered,
    maintenanceRelease,
    firstResult,
    maintenanceSettled,
    models,
    startMain,
    input,
    initialMessages,
    settledDrains: () => Promise.all(drains),
    snapshots: () => ({
      completedHistoryVersion,
      maintenanceHistoryVersion,
      finalMessages,
      maintenanceMessages,
    }),
  };
}
