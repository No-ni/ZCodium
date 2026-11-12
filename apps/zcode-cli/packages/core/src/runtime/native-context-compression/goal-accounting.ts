import {
  getModelUsageTotalTokens,
  traceContextToLogContext,
  type ModelUsageRecord,
  type SessionGoal,
  type TraceContext,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import { NativeContextRuntimeError } from "./contract.js";

export function nativeGoalBlocksMaintenance(goal: SessionGoal | null): boolean {
  return goal?.status === "paused" || goal?.status === "budget_limited";
}

export async function readNativeMaintenanceGoal(
  runtime: AgentRuntimeInternal,
): Promise<SessionGoal | null> {
  // resume 的上下文读取会把故障降为 null；付费门禁必须直接读既有 owner，未知不能当无 Goal。
  return await runtime.sessionStore!.readTarget({ sessionID: runtime.sessionId });
}

export async function freezeNativeMaintenanceGoal(
  runtime: AgentRuntimeInternal,
): Promise<SessionGoal | null> {
  const goal = await readNativeMaintenanceGoal(runtime);
  if (nativeGoalBlocksMaintenance(goal))
    throw new NativeContextRuntimeError(
      "unavailable",
      goal!.status === "paused" ? "goal-paused" : "goal-budget-limited",
    );
  return goal;
}

export function nativeGoalUsageCallback(
  runtime: AgentRuntimeInternal,
  frozenGoal: SessionGoal | null,
  traceContext: TraceContext,
): (record: ModelUsageRecord) => Promise<void> {
  let previousTarget = frozenGoal;
  return async (record) => {
    if (!frozenGoal) return;
    const usage = {
      totalTokens: record.providerTotalTokens,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cacheReadTokens: record.cacheReadInputTokens,
      cacheWriteTokens: record.cacheCreationInputTokens,
    };
    // 只用公共出口已归一化的真实数字；完全未知不写零 receipt，input 已含缓存时不再相加。
    if (
      !Object.values(usage).some(
        (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
      )
    )
      return;
    try {
      const target = await runtime.sessionStore!.accountTargetUsage({
        sessionID: runtime.sessionId,
        targetID: frozenGoal.targetID,
        usageID: record.id,
        tokensUsedDelta: getModelUsageTotalTokens(usage),
      });
      if (target?.targetID !== frozenGoal.targetID) return;
      if (
        target.tokensUsed !== previousTarget?.tokensUsed ||
        target.status !== previousTarget?.status
      ) {
        await runtime.recordTargetChanged({
          action: "usage_accounted",
          previousTarget,
          source: "runtime",
          target,
          traceContext,
        });
      }
      previousTarget = target;
    } catch {
      // 独立维护不启动或结束 Goal run；沿既有 owner 隔离记账故障，不能把已完成回复变失败。
      runtime.logger?.warn("Failed to account native maintenance Goal usage", {
        ...traceContextToLogContext(traceContext),
        event: "target.account.failed",
        module: "core.runtime",
        status: "failed",
        targetId: frozenGoal.targetID,
      });
    }
  };
}
