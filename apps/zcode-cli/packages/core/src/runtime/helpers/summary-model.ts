import type { Model, ModelSelection, TraceContext } from "../deps.js";
import type { ModelApiOperation } from "@zcode/contracts";
import { traceContextToLogContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { createRuntimeModel } from "../methods/runtime-model.js";

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
    // 这里只选择模型；调用上下文由任务边界设置，避免覆盖标题 sidecar 的子 trace。
    return createRuntimeModel(runtime, { selection });
  } catch {
    logSummaryModelFallback(runtime, input, "model_creation_failed");
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
  } catch {
    // Host 拉取失败（旧 Host、请求超时）按缺省处理，不打断总结任务。
    logSummaryModelFallback(runtime, input, "host_resolution_failed");
    return undefined;
  }
}

function logSummaryModelFallback(
  runtime: AgentRuntimeInternal,
  input: { operation: string; traceContext: TraceContext },
  reason: "model_creation_failed" | "host_resolution_failed",
): void {
  try {
    // 原始异常可能携带凭据或 provider 配置；回退只记录固定原因。
    runtime.logger?.warn("Summary model selection fell back to session model", {
      ...traceContextToLogContext(input.traceContext),
      event: "summary_model.fallback",
      module: "core.runtime",
      operation: input.operation,
      reason,
    });
  } catch {
    // 诊断失败也不能阻止模型回退。
  }
}
