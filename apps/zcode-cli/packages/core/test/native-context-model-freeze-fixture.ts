import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import {
  CoreErrorType,
  createCoreError,
  createModelId,
  createModelProviderId,
  getCurrentModelInvocationContext,
  ModelTransportKind,
  type Model,
  type ModelRequest,
  type ModelResult,
  type ModelSelection,
} from "@zcode/contracts";
import { createRuntimeModel } from "../src/runtime/methods/runtime-model.js";
import { maintenanceGoalFixture } from "./native-context-maintenance-goal-fixture.js";
import { summaryResult, USAGE } from "./native-context-maintenance-fixture.js";

export interface FrozenMaintenanceCall {
  selection: ModelSelection;
  querySource: string;
  request: ModelRequest;
  requestId: string;
}

export async function modelFreezeFixture(
  t: TestContext,
  options: {
    automatic?: boolean;
    onMaintenance?: (call: FrozenMaintenanceCall) => Promise<void>;
  } = {},
) {
  const base = await maintenanceGoalFixture(t, { automatic: options.automatic });
  const calls: FrozenMaintenanceCall[] = [];
  const resolutions: ModelSelection[] = [];
  const choice = (id: string) => ({
    providerId: createModelProviderId(`freeze-provider-${id}`),
    modelId: createModelId(`freeze-model-${id}`),
    options: { reasoningLevel: "medium" },
  });
  const selection = {
    A: choice("A"),
    B: choice("B"),
    C: choice("C"),
    small: choice("small"),
    unavailable: choice("unavailable"),
  };
  const makeModel = (chosen: ModelSelection, contextWindow: number): Model => {
    const providerId = createModelProviderId(chosen.providerId);
    const modelId = createModelId(chosen.modelId);
    const model: Model = {
      ...base.model,
      providerId,
      modelId,
      options: chosen.options ?? {},
      properties: { ...base.model.properties, contextWindow },
      bind(patch) {
        return { ...model, options: { ...model.options, ...patch } };
      },
      async generateText(request) {
        const context = getCurrentModelInvocationContext();
        assert.ok(
          context?.traceContext && context.statusSink,
          "use the real runtime invocation/status owner",
        );
        const call: FrozenMaintenanceCall = {
          selection: structuredClone(chosen),
          request,
          querySource: String(context.metadata?.querySource ?? "unknown"),
          requestId: `freeze-physical-${calls.length + 1}`,
        };
        calls.push(call);
        const startedAt = Date.now();
        const identity = {
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
          ...identity,
          type: "model_request_started",
          timestamp: new Date(startedAt).toISOString(),
        });
        if (call.querySource === "native_context_maintenance") await options.onMaintenance?.(call);
        const result: ModelResult = {
          text:
            call.querySource === "native_context_maintenance"
              ? summaryResult(request.messages)
              : "Synthetic current complete answer.",
          finishReason: "stop",
          usage: USAGE,
          reasoning: [],
          toolCalls: [],
        };
        await context.statusSink.publish({
          ...identity,
          type: "model_request_completed",
          timestamp: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
          finishReason: result.finishReason,
          usage: result.usage,
        });
        return result;
      },
      streamText() {
        throw new Error("Unexpected stream in nonstreaming freeze fixture.");
      },
    };
    return model;
  };
  const models = new Map([
    [`${selection.A.providerId}/${selection.A.modelId}`, makeModel(selection.A, 32768)],
    [`${selection.B.providerId}/${selection.B.modelId}`, makeModel(selection.B, 65536)],
    [`${selection.C.providerId}/${selection.C.modelId}`, makeModel(selection.C, 8192)],
    [`${selection.small.providerId}/${selection.small.modelId}`, makeModel(selection.small, 2048)],
  ]);
  base.runtime.modelFactory = ({ selection: requested }) => {
    resolutions.push(structuredClone(requested));
    const model = models.get(`${requested.providerId}/${requested.modelId}`);
    if (!model)
      throw createCoreError(
        CoreErrorType.ConfigurationError,
        "Synthetic removed model selection.",
        { recoverable: true },
      );
    return model;
  };
  base.runtime.setSessionModelSelection(selection.A);
  const selectedModel = (chosen: ModelSelection) =>
    createRuntimeModel(base.runtime, { selection: chosen });
  const safePoint = (chosen: ModelSelection = selection.A) => ({
    entries: base.runtime.messageHistory.borrowReadOnlyRuntimeEntries(),
    model: selectedModel(chosen),
    tools: [],
    traceContext: base.runtime.rootTraceContext,
  });
  const input = (chosen: ModelSelection, commandId: string) => ({
    model: structuredClone(chosen),
    commandId,
    abortSignal: new AbortController().signal,
    traceContext: base.runtime.rootTraceContext,
  });
  return { ...base, calls, resolutions, selection, safePoint, selectedModel, input };
}
