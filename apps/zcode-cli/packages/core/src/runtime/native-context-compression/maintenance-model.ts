import {
  createChildTraceContext,
  runWithModelInvocationContext,
  type Model,
  type ModelInputMessage,
  type SessionEvent,
} from "@zcode/contracts";
import type {
  NativeContextOperation,
  NativeContextStoredState,
} from "@zcode/shared/native-context-compression";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeModelTextResult } from "../types.js";
import type { NativeContextSafePoint, NativeContextRequestComparison } from "./contract.js";
import { NativeContextRuntimeError } from "./contract.js";
import { createRuntimeModel } from "../methods/runtime-model.js";
import {
  resolveNormalRequestMaxOutputTokens,
  resolveModelStepMaxOutputTokens,
} from "../methods/model-token-limits.js";
import { runCompactSummaryModelRequest } from "../methods/compact-summary-model-request.js";
import { recordModelUsageFact } from "../methods/usage-observability.js";
import { nativeTextEstimate } from "./measurements.js";
import { createNativeAttemptTracker } from "./attempts.js";
import { prepareNativeMaintenanceMedia } from "./maintenance-media.js";
import type { NativeOutputCandidate } from "./tool-views.js";
import { freezeNativeMaintenanceGoal, nativeGoalUsageCallback } from "./goal-accounting.js";

export function nativeMaintenanceModel(
  runtime: AgentRuntimeInternal,
  input: NativeContextSafePoint,
  state: NativeContextStoredState,
): Model {
  const selection = state.policy.parameters.maintenance.model;
  return selection === "follow-current" ? input.model : createRuntimeModel(runtime, { selection });
}
export function nativeMaintenanceOutputBudget(
  model: Model,
  state: NativeContextStoredState,
  estimatedInput = 0,
  decision = false,
): number {
  const normal = resolveNormalRequestMaxOutputTokens({
    modelMaxOutputTokens: model.optionSpecs.maxOutputTokens.max,
  });
  const explicit = decision
    ? state.policy.parameters.trigger.decisionMaxOutputTokens
    : state.policy.parameters.maintenance.maxOutputTokens;
  if (explicit !== "auto" && explicit > normal)
    throw new NativeContextRuntimeError("unavailable", "model-budget");
  return resolveModelStepMaxOutputTokens({
    baselineMaxOutputTokens: explicit === "auto" ? normal : explicit,
    contextWindow: model.properties.contextWindow,
    estimatedCurrentUsage: estimatedInput,
    modelContextBudgetStrategy: "preflight-v1",
  });
}
export async function callNativeMaintenanceModel(
  runtime: AgentRuntimeInternal,
  input: {
    safePoint: NativeContextSafePoint;
    state: NativeContextStoredState;
    model: Model;
    operation: NativeContextOperation;
    messages: ModelInputMessage[];
    outputs?: readonly NativeOutputCandidate[];
    decision?: boolean;
  },
): Promise<{ result: RuntimeModelTextResult; observationIds: string[] }> {
  const { model, state, safePoint, operation } = input;
  const messages =
    !input.decision && input.outputs?.length
      ? await prepareNativeMaintenanceMedia(runtime, {
          state,
          model,
          safePoint,
          outputs: input.outputs,
          messages: input.messages,
          operationId: operation.operationId,
        })
      : input.messages;
  const querySource = input.decision ? "native_context_decision" : "native_context_maintenance";
  const traceContext = createChildTraceContext(safePoint.traceContext, {
    attributes: { querySource, model: `${model.providerId}/${model.modelId}` },
  });
  const events: SessionEvent[] = [];
  const maxOutputTokens = nativeMaintenanceOutputBudget(
    model,
    state,
    nativeTextEstimate(messages, []),
    input.decision,
  );
  const comparison: NativeContextRequestComparison = {
    baselineMessages: messages,
    baselineEntries: safePoint.entries,
    historyVersion: state.historyVersion,
    generation: state.generation,
    policyVersion: state.policy.policyVersion,
    policy: structuredClone(state.policy),
    segmentId: state.compactBoundaryId,
    operationIds: [operation.operationId],
  };
  const tracker = createNativeAttemptTracker(runtime, {
    comparison,
    policy: state.policy,
    model,
    beforeMessages: messages,
    afterMessages: messages,
    tools: [],
    maxOutputTokens,
    traceContext,
    sentImages: [],
    imageChanges: { omittedRefs: [], foldedRefs: [], resizedRefs: [], restoredRefs: [] },
    purpose: input.decision ? "decision" : "maintenance",
    querySource,
    operationId: operation.operationId,
  });
  const statusSink = runtime.createModelStatusSink(traceContext, events, {
    onStatus: (event) => tracker.onStatus(event),
  });
  const request = {
    messages,
    tools: [],
    toolSearchEnabled: false,
    abortSignal: safePoint.signal,
    options: { maxOutputTokens },
  };
  // FIFO admission 后 Goal 仍可能暂停/换目标；每个决策或摘要的真正调用前重新读 owner 并冻结归属。
  const frozenGoal = await freezeNativeMaintenanceGoal(runtime);
  safePoint.signal?.throwIfAborted();
  const startedAt = Date.now();
  let result: RuntimeModelTextResult | undefined, error: unknown;
  try {
    if (
      state.policy.parameters.maintenance.stream === "always" ||
      runtime.shouldStreamModelText()
    ) {
      // 复用原生 compact 的完整流判定与有界 HTTP 替换，不把未完成 SSE 当作摘要。
      result = await runCompactSummaryModelRequest({
        model,
        request: {
          ...request,
          maxOutputTokens,
          traceContext,
          statusSink,
          preserveProviderStreamBoundaries: true,
          modelCall: {
            actorKind: "system",
            operation: "context_compaction",
            operationId: operation.operationId,
          },
          metadata: { querySource },
        },
      });
    } else {
      result = await runWithModelInvocationContext(
        {
          traceContext,
          statusSink,
          metadata: { querySource },
          modelCall: {
            actorKind: "system",
            operation: "context_compaction",
            operationId: operation.operationId,
          },
        },
        () => model.generateText(request),
      );
    }
    if (safePoint.signal?.aborted) throw safePoint.signal.reason;
    if (
      !result.text.trim() ||
      result.toolCalls?.length ||
      /(?:length|context|content_filter|unknown)/u.test(result.finishReason)
    ) {
      throw new NativeContextRuntimeError("invalid-range", "incomplete-model-response");
    }
    await tracker.finish({ status: "completed", usage: result.usage });
    return { result, observationIds: [...tracker.observationIds] };
  } catch (caught) {
    error = caught;
    await tracker.finish({
      status: safePoint.signal?.aborted ? "cancelled" : "error",
      usage: result?.usage,
    });
    throw caught;
  } finally {
    operation.observationIds.push(
      ...tracker.observationIds.filter((id) => !operation.observationIds.includes(id)),
    );
    await recordModelUsageFact(runtime, {
      error,
      events,
      model,
      networkEventStartIndex: 0,
      onModelUsage: nativeGoalUsageCallback(runtime, frozenGoal, traceContext),
      querySource,
      result,
      startedAt,
      status: error === undefined ? "completed" : safePoint.signal?.aborted ? "cancelled" : "error",
      traceContext,
    });
  }
}
