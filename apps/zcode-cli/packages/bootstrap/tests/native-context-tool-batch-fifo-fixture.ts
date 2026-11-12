import assert from "node:assert/strict";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import {
  createSessionId,
  SessionEventType,
  type MessageWithParts,
  type SessionEvent,
  type ToolPart,
  type TurnCompletePayload,
} from "@zcode/contracts";
import type { ToolRegistry } from "@zcode/core";
import { zcodeProtocolMethods, type ZCodeProtocolMethod } from "@zcode/shared";
import {
  V4_METHODS,
  commandAckSchema,
  conversationTopic,
  conversationTopicFrameSchema,
  routedTopicWireFrameSchema,
  type CommandEnvelope,
  type CommandPayloadMap,
  type CommandType,
} from "@zcode/shared/zcode-protocol-v4";
import {
  createRecommendedNativeContextConfiguration,
  nativeContextStatusSchema,
  type NativeContextStoredState,
} from "@zcode/shared/native-context-compression";
import {
  assertProjectPath,
  createProjectTestFixture,
} from "../../../../../scripts/ci/project-test-sandbox.mjs";
import { createZCodeApp, type ZCodeApp } from "../src/index.js";
import { ZCodeProtocolAgentServer } from "../src/zcode-protocol/server.js";
import { createBatchProviderRegistry } from "./native-context-tool-batch-registry.js";
import { gatedBatchTool } from "./native-context-tool-batch-tools.js";
import {
  batchSignal,
  BootstrapBatchModelAdapter,
  BATCH_CALL_IDS,
  BATCH_MAIN,
  BATCH_MAINTENANCE,
  BATCH_OLD_TEXT,
  BATCH_TOOLS,
} from "./native-context-tool-batch-model.js";

export function batchToolParts(messages: readonly MessageWithParts[]): ToolPart[] {
  return messages.flatMap((message) =>
    message.parts.filter((part): part is ToolPart => part.type === "tool"),
  );
}

export async function createBootstrapBatchFixture(
  t: TestContext,
  clientMode: "desktop-continuous" | "web-remote-replayable",
) {
  const directory = await createProjectTestFixture("native-bootstrap-tool-batch");
  const dbPath = await assertProjectPath(join(directory, "bootstrap.sqlite"));
  const store = await createSqliteSessionStore({ dbPath });
  const sessionId = createSessionId(`native-bootstrap-${clientMode}`);
  const order: string[] = [],
    events: SessionEvent[] = [];
  const tools = [0, 1].map(() => ({ entered: batchSignal(), release: batchSignal() }));
  const finalEntered = batchSignal(),
    finalRelease = batchSignal();
  const maintenanceEntered = batchSignal(),
    maintenanceRelease = batchSignal();
  const firstToolResult = batchSignal(),
    maintenanceSettled = batchSignal();
  const completions = new Map<string, ReturnType<typeof batchSignal>>();
  let app!: ZCodeApp;
  let admissionState: NativeContextStoredState | null = null;
  let runningState: NativeContextStoredState | null = null;
  let maintenanceMessages: MessageWithParts[] = [];
  const models: BootstrapBatchModelAdapter = new BootstrapBatchModelAdapter(
    {
      order,
      finalEntered,
      finalRelease,
      maintenanceEntered,
      maintenanceRelease,
      beforeFinal: async () => {
        const messages = await store.messages({ sessionID: sessionId });
        const parts = batchToolParts(messages);
        assert.deepEqual(
          parts.map((part) => part.callID),
          BATCH_CALL_IDS,
        );
        assert.deepEqual(
          parts.map((part) => part.state.status),
          ["completed", "completed"],
        );
        assert.equal(
          models.calls.filter((call) => call.model.modelId === BATCH_MAINTENANCE.modelId).length,
          0,
        );
      },
      beforeMaintenance: async () => {
        maintenanceMessages = await store.messages({ sessionID: sessionId });
        const final = maintenanceMessages.at(-1)!;
        assert.ok(final.info.role === "assistant");
        assert.ok(final.info.time.completed);
        assert.ok(final.parts.some((part) => part.type === "step-finish"));
        assert.deepEqual(
          batchToolParts(maintenanceMessages).map((part) => part.state.status),
          ["completed", "completed"],
        );
        runningState = await store.getNativeContextState(sessionId);
        assert.ok(admissionState && runningState);
        assert.notEqual(runningState.historyVersion, admissionState.historyVersion);
        const operations = await store.listNativeContextOperations(sessionId, { limit: 200 });
        assert.equal(operations.items.length, 1);
        const operation = await store.getNativeContextOperation(
          sessionId,
          operations.items[0]!.operationId,
        );
        assert.ok(operation);
        assert.equal(operation.status, "running");
        assert.equal(operation.historyVersion, runningState.historyVersion);
        assert.equal(operation.anchorMessageId, final.info.id);
        assert.equal(operation.generation, admissionState.generation);
        assert.equal(operation.policyVersion, admissionState.policy.policyVersion);
        assert.equal(operation.segmentId, runningState.compactBoundaryId);
      },
    },
    process.env,
  );
  const configuration = createRecommendedNativeContextConfiguration("manual");
  configuration.parameters.history.preserveTurns = 0;
  configuration.parameters.history.preserveMessages = 0;
  configuration.parameters.history.preserveTokens = 0;
  configuration.parameters.summary.minRangeChars = 1;
  configuration.parameters.summary.minChars = 16;
  configuration.parameters.trigger.minBenefitTokens = 0;
  const server = new ZCodeProtocolAgentServer({
    cwd: directory,
    env: process.env,
    sessionStore: store,
    createZCodeApp: async (options) => {
      assert.equal(app, undefined, "the test must use one Bootstrap-created Runtime");
      app = await createZCodeApp({
        ...options,
        sessionStore: store,
        env: process.env,
        skipUserConfig: true,
        providerRegistry: createBatchProviderRegistry(),
        modelAdapter: models,
        configuredDefaultModelSelection: BATCH_MAIN,
        runtimeConfig: {
          ...options?.runtimeConfig,
          workingDirectory: directory,
          workspacePath: directory,
          mode: "build",
          modelSelection: BATCH_MAIN,
          modelStreaming: "on",
          streamingToolExecution: "off",
          titleGeneration: { enabled: false },
          memory: { enabled: false, extractionEnabled: false },
          subagents: { enabled: false },
          mcp: { enabled: false, servers: {} },
          toolSearch: { mode: "off" },
          toolAllowlist: BATCH_TOOLS,
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
        eventSink: {
          async onSessionEvent(event) {
            await options?.eventSink?.onSessionEvent(event);
            events.push(event);
            if (
              event.type === SessionEventType.ToolCallResult &&
              (event.payload as { toolCallId: string }).toolCallId === BATCH_CALL_IDS[0]
            )
              firstToolResult.resolve();
            if (event.type === SessionEventType.TurnComplete) {
              const payload = event.payload as TurnCompletePayload;
              assert.equal(payload.resultType, "success");
              order.push(`complete:${payload.inputId}`);
              if (payload.inputId) completions.get(payload.inputId)?.resolve();
            }
            if (event.type === SessionEventType.NativeContextCompressionUpdated) {
              const status = nativeContextStatusSchema.parse(event.payload);
              if (status.phase === "idle" && status.lastOperation?.status === "completed")
                maintenanceSettled.resolve();
            }
          },
        },
      });
      // App 暴露的 Runtime 已创建默认 scheduler/executor；只经既有 registry 注入纯工具。
      const registry = (app.runtime as unknown as { registry: ToolRegistry }).registry;
      registry.register(gatedBatchTool(0, tools[0]!, order));
      registry.register(gatedBatchTool(1, tools[1]!, order));
      return app;
    },
  });
  server.setNotificationSink((message) => {
    if ("id" in message && message.method === zcodeProtocolMethods.sessionRequestRuntimePreferences)
      void server.handleMessage({
        id: message.id,
        result: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false },
      });
  });
  t.after(async () => {
    tools.forEach((tool) => tool.release.resolve());
    finalRelease.resolve();
    maintenanceRelease.resolve();
    await server.shutdown();
    server.disposeProjections();
    await store.close();
  });
  let requestSequence = 0;
  const query = async (method: ZCodeProtocolMethod, params: unknown) => {
    const response = await server.handleMessage({
      id: `query-${++requestSequence}`,
      method,
      params,
    });
    assert.ok(response && "result" in response, JSON.stringify(response));
    return response.result;
  };
  const command = async <T extends CommandType>(
    type: T,
    commandId: string,
    payload: CommandPayloadMap[T],
    scope: string | null = sessionId,
  ) => {
    const envelope: CommandEnvelope = {
      type,
      commandId,
      payload,
      sessionId: scope,
      clientId: `batch-${clientMode}`,
      issuedAt: Date.now(),
    };
    const response = await server.handleMessage({
      id: `command-${++requestSequence}`,
      method: V4_METHODS.command,
      params: envelope,
    });
    assert.ok(response && "result" in response, JSON.stringify(response));
    return commandAckSchema.parse(response.result);
  };
  const created = await command(
    "createSession",
    "bootstrap-create",
    {
      sessionId,
      workspaceId: directory,
      config: {
        modelSelection: BATCH_MAIN,
        nativeContextCompression: configuration,
        followupMode: "queue",
      },
    },
    null,
  );
  assert.equal(created.status, "accepted", JSON.stringify(created));
  assert.equal(created.result?.type, "createSession");
  assert.equal(
    created.result && "sessionId" in created.result ? created.result.sessionId : null,
    sessionId,
  );
  const subscriptionId = `subscribe-${++requestSequence}`;
  const subscribed = await server.handleMessage({
    id: subscriptionId,
    method: V4_METHODS.conversationSubscribe,
    params: {
      topic: conversationTopic(sessionId),
      connectionId: `batch-${clientMode}`,
      clientMode,
    },
  });
  assert.ok(subscribed && "result" in subscribed);
  const initial = server.takePostResponseMessages(subscriptionId);
  assert.ok(initial.length > 0);
  const wire = routedTopicWireFrameSchema.parse(initial[0]!.params);
  assert.equal(wire.kind, "complete");
  if (wire.kind === "complete")
    assert.equal(conversationTopicFrameSchema.parse(wire.frame).payload.kind, "snapshot");
  const completion = (inputId: string) => {
    let signal = completions.get(inputId);
    if (!signal) {
      signal = batchSignal();
      completions.set(inputId, signal);
    }
    return signal.promise;
  };
  const seedDone = completion("bootstrap-seed");
  const seeded = await command("sendText", "bootstrap-seed", {
    text: BATCH_OLD_TEXT,
    modelSelection: BATCH_MAIN,
  });
  assert.equal(seeded.status, "accepted");
  await seedDone;
  assert.equal(models.calls.length, 1);
  assert.equal(
    (await store.listNativeContextObservations(sessionId, { purpose: "maintenance" })).items.length,
    0,
  );
  const seedMessages = await store.messages({ sessionID: sessionId });
  // Bootstrap 还持久化系统上下文；只按本次实际输入/回复定位这对完整原文，不硬编码总消息数。
  assert.deepEqual(
    seedMessages
      .filter((message) =>
        message.parts.some((part) => part.type === "text" && part.text === BATCH_OLD_TEXT),
      )
      .map((message) => message.info.role),
    ["user", "assistant"],
  );
  const freezeAdmission = async () => {
    admissionState = await store.getNativeContextState(sessionId);
    return admissionState;
  };
  return {
    app,
    server,
    store,
    sessionId,
    order,
    events,
    tools,
    models,
    command,
    query,
    completion,
    finalEntered,
    finalRelease,
    firstToolResult,
    maintenanceEntered,
    maintenanceRelease,
    maintenanceSettled,
    waitFor: <T>(promise: Promise<T>): Promise<T> =>
      Promise.race([promise, models.failure.promise]),
    freezeAdmission,
    snapshots: () => ({ admissionState, runningState, maintenanceMessages }),
  };
}
