import type { Model, ModelSelection, TraceContext } from "../deps.js";
import type { ModelApiOperation } from "@zcode/contracts";
import { traceContextToLogContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { createRuntimeModel, withModelInvocationContext } from "../methods/runtime-model.js";

/**
 * 解析「总结模型」：宿主偏好优先，缺省/失败回退当轮 Turn Model。
 * Memory Extraction 与标题生成共用同一条优先链；回退只记日志，
 * 绝不让设置失效拖垮后台总结任务。
 */
export async function resolveSummaryModel(
  runtime: AgentRuntimeInternal,
  input: {
    /** 当轮回退模型（Turn Model 或调用方已构造的实例）；undefined 表示无回退。 */
    fallback?: Model;
    operation: ModelApiOperation;
    traceContext: TraceContext;
  },
): Promise<Model | undefined> {
  const selection = await resolveSummaryModelSelection(runtime, input);
  if (!selection) return input.fallback;

  try {
    const baseModel = createRuntimeModel(runtime, { selection });
    // 与 captureProjectMemoryAgentContext 相同的调用上下文包装：querySource 与
    // modelCall 记账跟随「为什么调」，而不是借用主链路的 turn 语义。
    return withModelInvocationContext(baseModel, () => ({
      metadata: {
        ...traceContextToLogContext(input.traceContext),
        querySource: input.operation,
      },
      modelRequestSessionType: "other",
      modelCall: { operation: input.operation },
      traceContext: input.traceContext,
    }));
  } catch (error) {
    logSummaryModelFallback(runtime, input, {
      errorMessage: error instanceof Error ? error.message : String(error),
      reason: "model_creation_failed",
      providerId: selection.providerId,
      modelId: selection.modelId,
    });
    return input.fallback;
  }
}

export async function resolveSummaryModelSelection(
  runtime: AgentRuntimeInternal,
  input: { operation: string; traceContext: TraceContext },
): Promise<ModelSelection | undefined> {
  const resolveFromHost = runtime.resolveSummaryModelSelection;
  if (!resolveFromHost) return undefined;

  try {
    const selection = await resolveFromHost();
    if (!selection) return undefined;
    return selection;
  } catch (error) {
    // Host 拉取失败（旧 Host、请求超时）按缺省处理，不打断总结任务。
    logSummaryModelFallback(runtime, input, {
      errorMessage: error instanceof Error ? error.message : String(error),
      reason: "host_resolution_failed",
    });
    return undefined;
  }
}

function logSummaryModelFallback(
  runtime: AgentRuntimeInternal,
  input: { operation: string; traceContext: TraceContext },
  detail: {
    errorMessage: string;
    reason: string;
    providerId?: string;
    modelId?: string;
  },
): void {
  runtime.logger?.warn("Summary model selection fell back to session model", {
    ...traceContextToLogContext(input.traceContext),
    event: "summary_model.fallback",
    module: "core.runtime",
    operation: input.operation,
    ...detail,
  });
}
