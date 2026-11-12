import type { TestContext } from "node:test";
import {
  createPartId,
  createTurnId,
  InMemorySessionEventStore,
  type Logger,
  type MessageWithParts,
  type ModelInputMessage,
  type ModelUsageRecord,
  type SessionEvent,
} from "@zcode/contracts";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import {
  createRecommendedNativeContextConfiguration,
  type NativeContextCommit,
} from "@zcode/shared/native-context-compression";
import { createProjectTestFixture } from "../../../../../scripts/ci/project-test-sandbox.mjs";
import { sessionInput } from "../../adapters/test/fixtures/native-context-store.js";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { TurnMachineImpl } from "../src/agent/turn-machine.js";
import { hydrateMessageHistoryFromSession } from "../src/agent/session-history-hydrator.js";
import type { RegularTurnLoopState } from "../src/runtime/methods/turn-loop-state.js";
import { runModelBackedTurnStep } from "../src/runtime/methods/turn-model-step.js";
import { prepareRuntimeProviderRequest } from "../src/runtime/helpers/runtime-provider-request-messages.js";
import { nativeProjectionForRequest } from "../src/runtime/native-context-compression/index.js";
import {
  initialNativeState,
  kernelOf,
  nativeOwner,
} from "../src/runtime/native-context-compression/state.js";
import { syncNativeSources } from "../src/runtime/native-context-compression/sources.js";
import { nativeCountTokens } from "../src/runtime/native-context-compression/measurements.js";
import { block, message, operation, PARENT } from "./native-context-boundary-fixture.js";
import { imageFixture, pngHeaderBytes } from "./native-context-image-fixture.js";
import { createMainRequestModelFixture } from "./native-context-main-request-model-fixture.js";

export { ANSWER, USAGE } from "./native-context-main-request-model-fixture.js";

export const OLD_TEXT =
  "synthetic original canonical history: a completed observation and decision. ".repeat(160);
export const SUMMARY =
  "Fixture compressed summary: retain the completed decision and its constraints.";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

export async function mainRequestFixture(
  t: TestContext,
  options: {
    images?: boolean;
    streaming?: boolean;
    holdAssistantCompletion?: boolean;
    rejectAt?: "step-finish" | "assistant-complete" | "image-receipt";
  } = {},
) {
  const directory = await createProjectTestFixture("native-main-request");
  const store = await createSqliteSessionStore({ dbPath: ":memory:" });
  const completionReached = gate(),
    releaseCompletion = gate();
  const rejection = new Error("synthetic selected persistence rejection");
  const order: string[] = [];
  const usages: ModelUsageRecord[] = [];
  const receiptWrites: { response: MessageWithParts | null; commit: NativeContextCommit }[] = [];
  const events: SessionEvent[] = [],
    warnings: { message: string; context: unknown }[] = [];
  let faultConsumed = false;
  const hooks: Partial<typeof store> = {
    async savePart(part, copyFrom) {
      if (part.type === "step-finish" && options.rejectAt === "step-finish" && !faultConsumed) {
        faultConsumed = true;
        throw rejection;
      }
      await store.savePart(part, copyFrom);
      if (part.type === "step-finish") order.push("step-finish-durable");
    },
    async saveMessage(info, copyFrom) {
      const completing = info.role === "assistant" && Number.isFinite(info.time.completed);
      if (completing) {
        completionReached.resolve();
        if (options.holdAssistantCompletion) await releaseCompletion.promise;
        if (options.rejectAt === "assistant-complete" && !faultConsumed) {
          faultConsumed = true;
          throw rejection;
        }
      }
      await store.saveMessage(info, copyFrom);
      if (completing) order.push("assistant-complete-durable");
    },
    async commitNativeContext(sessionId, commit) {
      if (commit.state.imageReceipts.length) {
        const response = await store.messageWithParts({
          sessionID: sessionId,
          messageID: commit.state.imageReceipts[0]!
            .responseMessageId as MessageWithParts["info"]["id"],
        });
        receiptWrites.push({ response, commit: structuredClone(commit) });
        order.push("image-receipt-attempt");
        if (options.rejectAt === "image-receipt" && !faultConsumed) {
          faultConsumed = true;
          throw rejection;
        }
      }
      await store.commitNativeContext(sessionId, commit);
    },
    async recordModelUsage(usage) {
      await store.recordModelUsage(usage);
      usages.push(structuredClone(usage));
    },
  };
  const sessionStore = new Proxy(store, {
    get(target, key) {
      const hook = Reflect.get(hooks, key);
      if (hook) return hook;
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const rows = async () =>
    (await store.listNativeContextObservations(PARENT, { purpose: "main", limit: 200 })).items;
  const { model, providerId, modelId, calls, prepared } = createMainRequestModelFixture({
    images: options.images,
    order,
    rows,
  });
  const images = imageFixture();
  const agent = new AgentRuntime(
    PARENT,
    {
      workingDirectory: directory,
      mode: "build",
      taskType: "interactive",
      modelSelection: { providerId, modelId },
      modelStreaming: options.streaming ? "on" : "off",
      memory: { enabled: false },
      subagents: { enabled: false },
      mcp: { enabled: false, servers: {} },
    },
    {
      eventStore: new InMemorySessionEventStore(),
      sessionStore,
      modelFactory: () => model,
      artifactStore: images.runtime.artifactStore,
      imageProcessorPort: images.runtime.imageProcessorPort,
      eventSink: {
        onSessionEvent(event) {
          events.push(event);
        },
      },
    },
  );
  const runtime = agent as unknown as AgentRuntimeInternal;
  t.after(async () => {
    releaseCompletion.resolve();
    agent.beginShutdown();
    await store.close();
  });
  const logger: Logger = {
    debug() {},
    info() {},
    error() {},
    child() {
      return logger;
    },
    warn(message, context) {
      warnings.push({ message, context });
    },
  };
  runtime.logger = logger;
  runtime.sessionPersisted = true;
  runtime.turnNumber = 1;
  const messages = [
    message("main-old-user"),
    message("main-old-assistant", "assistant"),
    message("main-latest-user"),
  ];
  for (const item of messages.slice(0, 2)) {
    const text = item.parts.find((part) => part.type === "text")!;
    if (text.type === "text") text.text = OLD_TEXT;
  }
  const latest = messages.at(-1)!;
  if (options.images) {
    // 此夹具只模拟宿主编解码结果，原图/副本字节与 canonical FilePart 走真实 runtime/storage 链路。
    images.addImage(
      latest.info.id,
      pngHeaderBytes(8192, 2048, 1024),
      createPartId("main-request-image"),
    );
    const part = images.messages.get(latest.info.id)!.parts.find((part) => part.type === "file")!;
    latest.parts.push({ ...part, sessionID: PARENT, messageID: latest.info.id });
  }
  await store.createSession(sessionInput(PARENT));
  await store.commitMessageBundle({ sessionID: PARENT, messages });
  await hydrateMessageHistoryFromSession({
    history: runtime.messageHistory,
    messages,
    artifactStore: runtime.artifactStore,
  });
  runtime.latestConversationMessageId = latest.info.id;
  const state = initialNativeState(runtime, createRecommendedNativeContextConfiguration("auto"));
  state.policy.policyVersion = 3;
  state.policy.parameters.history.preserveTurns = 0;
  state.policy.parameters.history.preserveMessages = 0;
  state.policy.parameters.history.preserveTokens = 0;
  syncNativeSources(
    state,
    runtime.messageHistory.borrowReadOnlyRuntimeEntries(),
    nativeCountTokens,
  );
  const oldIds = new Set(messages.slice(0, 2).map((item) => String(item.info.id)));
  const oldSources = state.sources.filter(
    (source) => oldIds.has(source.messageId) && source.kind === "text",
  );
  const compressed = block(
    "fixture-compressed-block",
    oldSources.map((source) => source.rawId),
  );
  compressed.summary = SUMMARY;
  kernelOf(state).compression.blocks = [compressed];
  const seed = operation("seed-compression", {
    status: "completed",
    policyVersion: state.policy.policyVersion,
    historyVersion: state.historyVersion,
    segmentId: state.compactBoundaryId,
    completedAt: 20,
    elapsedMs: 10,
    blockIds: [compressed.blockId],
    summary: SUMMARY,
    sources: oldSources.map((source) => ({
      ref: source.ref,
      messageId: source.messageId,
      partId: source.partId,
      imageIndex: source.imageIndex,
      kind: "text" as const,
      originalAvailable: source.originalAvailable,
    })),
    anchorMessageId: latest.info.id,
  });
  await store.commitNativeContext(PARENT, {
    expectedRevision: null,
    expectedGeneration: 0,
    state,
    operations: [seed],
  });
  const owner = nativeOwner(runtime);
  owner.state = structuredClone(state);
  owner.pendingOperationIds = [seed.operationId];
  const original = structuredClone(runtime.messageHistory.borrowReadOnlyRuntimeEntries());
  const native = nativeProjectionForRequest(runtime, original, model, []);
  const provider = prepareRuntimeProviderRequest(runtime, {
    entries: native.entries,
    model,
    tools: [],
    registry: runtime.registry,
  });
  const turnId = createTurnId("native-main-request");
  const trace = { ...runtime.rootTraceContext, turnId };
  let machine = TurnMachineImpl.create(PARENT, 1, "main-latest-user", trace.traceId, turnId);
  machine = new TurnMachineImpl(machine.start());
  machine = new TurnMachineImpl(machine.startModelRequest(modelId, provider.request.messages));
  const loop: RegularTurnLoopState = {
    model,
    currentUserMessageId: latest.info.id,
    userMessageId: latest.info.id,
    input: "main-latest-user",
    events: [],
    modelResponse: "",
    modelStepCount: 0,
    historyRoundCount: 0,
    tokenCount: 0,
    toolCallCount: 0,
    anomalyWarningsInjected: 0,
    backgroundSubagentResultConsumed: false,
    workflowResultConsumed: false,
    completedRealToolResultBatch: false,
    inputAttachmentCollectionPending: false,
    reactiveCompactAttemptedInCurrentModelStep: false,
    repeatedToolCallStreakCount: 0,
    stopHookContinuationCount: 0,
    streamRecoveryRetryCount: 0,
    turnRequestState: { entries: original, outputTokenContinuationCount: 0 },
    traceId: trace.traceId,
    turnId,
    turnTraceContext: trace,
    turnAbortSignal: new AbortController().signal,
    turnMachine: machine,
  };
  return {
    runtime,
    store,
    model,
    loop,
    owner,
    original,
    messages,
    images,
    calls,
    prepared,
    usages,
    events,
    warnings,
    order,
    rejection,
    receiptWrites,
    completionReached,
    releaseCompletion,
    rows,
    comparison: native.comparison!,
    response: () =>
      store.messageWithParts({ sessionID: PARENT, messageID: runtime.latestAssistantMessageId! }),
    run: () =>
      runModelBackedTurnStep.call(runtime, loop, {
        nativeContextComparison: native.comparison,
        messages: provider.request.messages,
        sourceEntries: provider.projection.sourceEntries,
        recordedMessages: provider.request.messages,
        requestEntries: original,
        latestRealUserMessageIndex: provider.projection.diagnostics.latestRealUserMessageIndex,
        tools: provider.request.tools,
        toolSearch: provider.toolSearch,
      }),
  };
}

export function requestText(messages: readonly ModelInputMessage[]): string {
  return messages
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n"),
    )
    .join("\n");
}
