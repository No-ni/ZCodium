import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import {
  createModelId,
  createModelProviderId,
  createSessionEvent,
  createTurnId,
  getCurrentModelInvocationContext,
  ModelTransportKind,
  type Model,
  type ModelInputMessage,
  type ModelRequest,
  type ModelResult,
  type ModelUsage,
  type SessionEvent,
} from "@zcode/contracts";
import type { NativeContextStoredState } from "@zcode/shared/native-context-compression";
import type { TurnResult } from "../src/runtime/types.js";
import { createRuntimeCommandId, createRuntimeCommandQueue } from "../src/runtime/command-queue.js";
import { createModelStatusSink } from "../src/runtime/methods/model-status.js";
import { readSessionTargetForContext } from "../src/runtime/methods/resume.js";
import { recordTargetChanged } from "../src/runtime/methods/target.js";
import {
  drainRuntimeCommandQueue,
  enqueueRuntimeCommand,
} from "../src/runtime/methods/runtime-command-queue.js";
import { nativeOwner, writeNativeState } from "../src/runtime/native-context-compression/state.js";
import { syncNativeSources } from "../src/runtime/native-context-compression/sources.js";
import { nativeCountTokens } from "../src/runtime/native-context-compression/measurements.js";
import { hydrateMessageHistoryFromSession } from "../src/agent/session-history-hydrator.js";
import { commit, fixture, message, PARENT } from "./native-context-boundary-fixture.js";

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

export interface MaintenanceCall {
  requestId: string;
  request: ModelRequest;
}
export type MaintenancePlan = (
  call: MaintenanceCall,
) => Partial<ModelResult> | Promise<Partial<ModelResult>>;
export const USAGE: ModelUsage = { inputTokens: 40, outputTokens: 8, cacheReadTokens: 0 };
export const SUMMARY = "合成摘要：保留当前决策、操作结果、标识符、约束与尚未完成的事项。".repeat(2);

export function summaryResult(messages: ModelInputMessage[], summary = SUMMARY): string {
  const user = messages.findLast((item) => item.role === "user");
  assert.equal(typeof user?.content, "string");
  const offered = JSON.parse(user!.content as string) as {
    ranges: { startRef: string; endRef: string }[];
  };
  assert.ok(offered.ranges.length > 0);
  return JSON.stringify({
    ranges: offered.ranges.map((range) => ({
      startRef: range.startRef,
      endRef: range.endRef,
      summary,
    })),
    outputs: [],
  });
}

export function chargedFailure(usage: ModelUsage = USAGE): Error & { reportedUsage: ModelUsage } {
  return Object.assign(new Error("synthetic provider failure"), { reportedUsage: usage });
}

export async function maintenanceFixture(
  t: TestContext,
  plan: MaintenancePlan = ({ request }) => ({ text: summaryResult(request.messages) }),
  configure?: (state: NativeContextStoredState) => void,
) {
  const messages = [
    message("old-user"),
    message("old-assistant", "assistant"),
    message("latest-user"),
  ];
  for (const item of messages.slice(0, 2)) {
    const text = item.parts.find((part) => part.type === "text")!;
    if (text.type === "text")
      text.text = "synthetic old repeated observation and completed decision. ".repeat(140);
  }
  const base = await fixture(t, messages);
  const { host, state, store } = base;
  state.policy.mode = "manual";
  state.policy.parameters.history.preserveTurns = 0;
  state.policy.parameters.history.preserveMessages = 0;
  state.policy.parameters.history.preserveTokens = 0;
  state.policy.parameters.summary.minRangeChars = 1;
  state.policy.parameters.summary.minChars = 16;
  state.policy.parameters.trigger.minBenefitTokens = 0;
  configure?.(state);
  await commit(host, state);
  const owner = nativeOwner(host);
  owner.state = structuredClone(state);
  const published: SessionEvent[] = [];
  const calls: MaintenanceCall[] = [];
  const order: string[] = [];
  const drains: Promise<void>[] = [];
  const providerId = createModelProviderId("maintenance-fixture-provider");
  const modelId = createModelId("maintenance-fixture-model");
  const model: Model = {
    providerId,
    modelId,
    options: { reasoningLevel: "medium" },
    properties: {
      requiresMfjsToolSchema: false,
      contextWindow: 32768,
      inputFormat: {
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: false,
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
    },
    optionSpecs: {
      reasoningLevel: { values: ["medium"], map: "({})" },
      maxOutputTokens: { max: 1024, map: "({})" },
    },
    bind(options) {
      return { ...model, options: { ...model.options, ...options } };
    },
    async generateText(request) {
      const context = getCurrentModelInvocationContext();
      assert.ok(
        context?.traceContext && context.statusSink,
        "use the actual runtime statusSink through model invocation context",
      );
      const call = { request, requestId: `maintenance-physical-${calls.length + 1}` };
      calls.push(call);
      order.push("maintenance");
      const start = Date.now();
      const status = {
        requestId: call.requestId,
        providerId,
        modelId,
        transport: ModelTransportKind.Http,
        attempt: 1,
        maxAttempts: 1,
        traceId: context.traceContext.traceId,
        spanId: context.traceContext.spanId,
      };
      await context.statusSink.publish({
        ...status,
        timestamp: new Date(start).toISOString(),
        type: "model_request_started",
      });
      try {
        const result: ModelResult = {
          text: "",
          reasoning: [],
          toolCalls: [],
          finishReason: "stop",
          usage: USAGE,
          ...(await plan(call)),
        };
        await context.statusSink.publish({
          ...status,
          timestamp: new Date().toISOString(),
          type: "model_request_completed",
          durationMs: Date.now() - start,
          finishReason: result.finishReason,
          usage: result.usage,
        });
        return result;
      } catch (error) {
        await context.statusSink.publish({
          ...status,
          timestamp: new Date().toISOString(),
          type: "model_request_failed",
          durationMs: Date.now() - start,
          reason: request.abortSignal?.aborted ? "cancelled" : "unknown",
          retryable: false,
          message: "synthetic provider failure",
          usage:
            error instanceof Error && "reportedUsage" in error
              ? (error.reportedUsage as ModelUsage)
              : undefined,
        });
        throw error;
      }
    },
    async *streamText() {
      throw new Error("unexpected fixture stream call");
    },
  };
  host.config = { taskType: "interactive", mode: "build" };
  host.sessionModelSelection = { providerId, modelId };
  host.latestConversationMessageId = messages.at(-1)!.info.id;
  host.modelFactory = () => model;
  host.shouldStreamModelText = () => false;
  host.registry = { list: () => [], get: () => undefined } as unknown as typeof host.registry;
  host.getTools = () => [];
  host.now = () => new Date();
  host.logModelNetworkStatus = () => undefined;
  host.createEvent = (type, payload, trace) =>
    createSessionEvent(type, PARENT, payload, { traceId: trace.traceId });
  host.appendEvent = async (event) => {
    published.push(event);
  };
  host.createModelStatusSink = createModelStatusSink.bind(host);
  host.readSessionTargetForContext = readSessionTargetForContext.bind(host);
  host.recordTargetChanged = recordTargetChanged.bind(host);
  host.runtimeCommandQueue = createRuntimeCommandQueue();
  host.runtimeCommandDrainActive = false;
  host.drainRuntimeCommandQueue = () => {
    const pending = drainRuntimeCommandQueue.call(host);
    drains.push(pending);
    return pending;
  };
  host.enqueueRuntimeCommand = enqueueRuntimeCommand.bind(host);
  host.executeTurnCommand = async (input) => {
    order.push(input);
    return {
      response: "synthetic prompt result",
      turnId: createTurnId("fixture-prompt"),
      traceId: host.rootTraceContext.traceId,
      events: [],
      projection: {} as TurnResult["projection"],
    };
  };
  const safePoint = () => ({
    entries: host.messageHistory.borrowReadOnlyRuntimeEntries(),
    model,
    tools: [],
    traceContext: host.rootTraceContext,
  });
  const observations = async (purpose: "main" | "maintenance" | "decision" = "maintenance") =>
    (await store.listNativeContextObservations(PARENT, { limit: 200, purpose })).items;
  const enqueuePrompt = (input: string) =>
    host.runtimeCommandQueue.enqueue({
      id: createRuntimeCommandId(),
      createdAt: new Date(),
      mode: "prompt",
      priority: "later",
      input,
      traceContext: host.rootTraceContext,
      resolve: () => undefined,
      reject: (error) => {
        throw error;
      },
    });
  const appendHistory = async () => {
    const added = message("later-real-user");
    messages.push(added);
    await store.commitMessageBundle({ sessionID: PARENT, messages: [added] });
    host.messageHistory.reset();
    await hydrateMessageHistoryFromSession({ history: host.messageHistory, messages });
    host.latestConversationMessageId = added.info.id;
    await writeNativeState(owner, (candidate) =>
      syncNativeSources(
        candidate,
        host.messageHistory.borrowReadOnlyRuntimeEntries(),
        nativeCountTokens,
      ),
    );
  };
  return {
    ...base,
    owner,
    model,
    calls,
    published,
    order,
    drains,
    safePoint,
    observations,
    enqueuePrompt,
    appendHistory,
  };
}
