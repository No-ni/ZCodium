import type { Model, ModelToolContract } from "@zcode/contracts";
import type { NativeContextOperation } from "@zcode/shared/native-context-compression";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import { prepareRuntimeProviderRequest } from "../helpers/runtime-provider-request-messages.js";
import { nativeInputBudget, validateNativeModelThresholds } from "./budgets.js";
export { nativeInputBudget } from "./budgets.js";
import type { NativeContextSafePoint, NativeContextRequestComparison } from "./contract.js";
import { nativeOwner, ensureNativeState, writeNativeState } from "./state.js";
import { syncNativeSources } from "./sources.js";
import { historyVersionOf } from "./identity.js";
import { nativeTextEstimate, nativeCountTokens } from "./measurements.js";
import { nativeThresholdTokens, nativeGrowthFloor } from "./kernel-config.js";
import { applyNativeToolViews, nativeOutputCandidates } from "./tool-views.js";
import { nativeOperation, finishNativeOperation } from "./records.js";
import {
  projectNativeEntries,
  projectNativeRequest,
  nativeEntriesWithImageIdentity,
} from "./projection.js";
import { bindNativeProjectionOperation } from "./projection-operations.js";
import { nativeMaintenanceRanges, advanceNativeSurvival } from "./candidates.js";
import { runNativeMaintenance } from "./maintenance.js";
import { appendNativeRequestGuidance } from "./request-guidance.js";
import type { AutoCompactTokenOverride } from "../deps.js";
import { nativeGoalBlocksMaintenance, readNativeMaintenanceGoal } from "./goal-accounting.js";

export function nativeContextOwnsProjection(runtime: AgentRuntimeInternal): boolean {
  // manual 同样由原生 owner 管理投影；旧 microcompact 不得偷偷新增不可回取的裁剪。
  return Boolean(runtime.sessionStore?.commitNativeContext);
}
/** 已发送的 usage 只锚定同模型/分支/深度整理段，增量始终取当前原生发送视图。 */
export function nativeContextTokenEstimate(
  runtime: AgentRuntimeInternal,
  messages: import("@zcode/contracts").ModelInputMessage[],
  tools: readonly ModelToolContract[],
  model: Model,
): number | null {
  if (!nativeOwner(runtime).state || !nativeContextOwnsProjection(runtime)) return null;
  return (
    nativeContextUsageTokenOverride(runtime, messages, tools, model)?.tokenCount ??
    nativeTextEstimate(messages, tools)
  );
}
/** 没有同发送视图的真实样本时，禁止把本地估算包装成 provider_usage。 */
export function nativeContextUsageTokenOverride(
  runtime: AgentRuntimeInternal,
  messages: import("@zcode/contracts").ModelInputMessage[],
  tools: readonly ModelToolContract[],
  model: Model,
): AutoCompactTokenOverride | undefined {
  const owner = nativeOwner(runtime),
    state = owner.state,
    previous = owner.lastObservation;
  if (
    !state ||
    !nativeContextOwnsProjection(runtime) ||
    previous?.purpose !== "main" ||
    previous.status !== "completed" ||
    previous.generation !== state.generation ||
    previous.generation !== runtime.branchGeneration ||
    previous.segmentId !== state.compactBoundaryId ||
    previous.model.providerId !== model.providerId ||
    previous.model.modelId !== model.modelId ||
    previous.actualInputTokens === null ||
    previous.textAfterEstimate === null
  )
    return undefined;
  const incrementalTokenCount = nativeTextEstimate(messages, tools) - previous.textAfterEstimate;
  return {
    source: "provider_usage",
    baseTokenCount: previous.actualInputTokens,
    incrementalTokenCount,
    tokenCount: Math.max(0, previous.actualInputTokens + incrementalTokenCount),
    outputTokens: previous.outputTokens ?? undefined,
    cacheReadTokens: previous.cacheReadTokens ?? undefined,
    cacheWriteTokens: previous.cacheCreateTokens ?? undefined,
  };
}
/** 深度整理与请求公告之后仅同步最终来源；同一个安全点不再启动第二次付费维护。 */
export async function synchronizeNativeRequestSources(
  runtime: AgentRuntimeInternal,
  entries: readonly RuntimeMessageEntry[],
): Promise<void> {
  if (!runtime.sessionStore?.commitNativeContext || !runtime.sessionPersisted) return;
  const owner = nativeOwner(runtime);
  await ensureNativeState(owner);
  if (owner.state!.historyVersion === historyVersionOf(entries)) return;
  await writeNativeState(owner, (next) => syncNativeSources(next, entries, nativeCountTokens));
}
export async function prepareNativeContext(
  runtime: AgentRuntimeInternal,
  input: NativeContextSafePoint,
): Promise<void> {
  if (!runtime.sessionStore?.commitNativeContext || !runtime.sessionPersisted) return;
  const owner = nativeOwner(runtime);
  await ensureNativeState(owner);
  owner.inputBudget = validateNativeModelThresholds(owner.state!.policy.parameters, input.model);
  const historyVersion = historyVersionOf(input.entries);
  let fresh = false;
  const facts: { operations: NativeContextOperation[] } = { operations: [] };
  // 参数保存可与安全点交错；纯转换在唯一写锁内读取当前策略，不能覆盖较新的 CAS。
  await writeNativeState(
    owner,
    (next) => {
      fresh = next.historyVersion !== historyVersion;
      syncNativeSources(next, input.entries, nativeCountTokens);
      if (
        next.policy.mode !== "auto" ||
        owner.phase === "compressing" ||
        owner.inputBudget === null
      )
        return;
      const before = prepareRuntimeProviderRequest(runtime, {
        entries: projectNativeEntries(input.entries, next),
        model: input.model,
        tools: [...input.tools],
        registry: runtime.registry,
      }).request;
      const affected = applyNativeToolViews(next, input.entries, {
        currentTokens:
          nativeContextTokenEstimate(runtime, before.messages, before.tools, input.model) ??
          nativeTextEstimate(before.messages, before.tools),
        inputBudget: owner.inputBudget,
      });
      if (fresh) {
        next.roundsSinceMaintenance++;
        advanceNativeSurvival(next);
      }
      if (affected.length) {
        const operation = finishNativeOperation(
          nativeOperation(next, {
            kind: "reference",
            trigger: "automatic",
            sources: affected,
            anchorMessageId: runtime.latestConversationMessageId,
          }),
          "completed",
        );
        bindNativeProjectionOperation(next, operation.operationId, {
          rawIds: affected.map((source) => source.rawId),
        });
        facts.operations.push(operation);
      }
    },
    facts,
  );
  if (
    owner.state!.policy.mode !== "auto" ||
    owner.phase === "compressing" ||
    owner.inputBudget === null
  )
    return;
  const projected = prepareRuntimeProviderRequest(runtime, {
    entries: projectNativeEntries(input.entries, owner.state!),
    model: input.model,
    tools: [...input.tools],
    registry: runtime.registry,
  }).request;
  const textTokens = nativeTextEstimate(projected.messages, projected.tools);
  const previous = owner.lastObservation;
  const sameMeter =
    previous?.status === "completed" &&
    previous.generation === owner.state!.generation &&
    previous.model.providerId === input.model.providerId &&
    previous.model.modelId === input.model.modelId &&
    previous.segmentId === owner.state!.compactBoundaryId;
  const tokenCount =
    sameMeter && previous.actualInputTokens !== null && previous.textAfterEstimate !== null
      ? Math.max(0, previous.actualInputTokens + textTokens - previous.textAfterEstimate)
      : textTokens;
  const actualSample = sameMeter && previous.actualInputTokens !== null;
  const parameters = owner.state!.policy.parameters;
  const capacity = tokenCount >= (owner.inputBudget * parameters.trigger.capacityPercent) / 100;
  const pressure = tokenCount >= nativeThresholdTokens(parameters.trigger.start, owner.inputBudget);
  const opportunity =
    tokenCount >= (owner.inputBudget * parameters.trigger.opportunisticPercent) / 100;
  const periodic =
    parameters.trigger.periodicCheckRounds > 0 &&
    owner.state!.roundsSinceMaintenance >= parameters.trigger.periodicCheckRounds;
  const interval = owner.state!.roundsSinceMaintenance >= parameters.trigger.checkIntervalRounds;
  const growth =
    tokenCount - owner.state!.lastMaintenanceTokens >=
    nativeGrowthFloor(parameters, owner.inputBudget);
  const ranges = nativeMaintenanceRanges(input.entries, owner.state!, owner.inputBudget);
  const tier = ranges[0]?.tier ?? 1;
  const tierGrowth =
    tokenCount - owner.state!.lastMaintenanceTokens >=
    nativeGrowthFloor(parameters, owner.inputBudget, tier);
  const outputs = nativeOutputCandidates(
    input.entries,
    owner.state!,
    tokenCount,
    owner.inputBudget,
  );
  const estimateHeld =
    !actualSample &&
    parameters.trigger.waitForUsageSample &&
    owner.state!.estimateHoldRounds < parameters.trigger.estimateHoldRounds;
  if (fresh)
    await writeNativeState(owner, (next) => {
      next.estimateHoldRounds = actualSample ? 0 : next.estimateHoldRounds + 1;
    });
  if (owner.state!.lastCheckedHistoryVersion === historyVersion) return;
  if (
    !outputs.length &&
    !(
      capacity ||
      (pressure && !estimateHeld) ||
      (opportunity && (periodic || (interval && growth && tierGrowth)))
    )
  )
    return;
  // 暂停/预算只阻止新付费检查，不消费同历史检查戳，恢复后仍有原规则规定的检查机会。
  if (nativeGoalBlocksMaintenance(await readNativeMaintenanceGoal(runtime))) return;
  await writeNativeState(owner, (next) => {
    next.lastCheckedHistoryVersion = historyVersion;
  });
  await runNativeMaintenance(runtime, input, capacity ? "capacity" : "automatic", undefined, {
    opportunistic: !pressure && !capacity,
    tokenCount,
  });
}
export function nativeProjectionForRequest(
  runtime: AgentRuntimeInternal,
  entries: readonly RuntimeMessageEntry[],
  model: Model,
  tools: readonly ModelToolContract[],
): { entries: RuntimeMessageEntry[]; comparison?: NativeContextRequestComparison } {
  const owner = nativeOwner(runtime);
  if (!owner.state || !runtime.sessionStore?.commitNativeContext) return { entries: [...entries] };
  const baseline = prepareRuntimeProviderRequest(runtime, {
    entries: nativeEntriesWithImageIdentity(entries),
    model,
    tools: [...tools],
    registry: runtime.registry,
  });
  const state = owner.state;
  const projected = projectNativeRequest(entries, state);
  return {
    entries: appendNativeRequestGuidance(
      projected.entries,
      entries,
      state,
      nativeInputBudget(model),
    ),
    comparison: {
      baselineMessages: baseline.request.messages,
      baselineLatestRealUserMessageIndex:
        baseline.projection.diagnostics.latestRealUserMessageIndex,
      baselineEntries: [...entries],
      historyVersion: state.historyVersion,
      generation: state.generation,
      policyVersion: state.policy.policyVersion,
      segmentId: state.compactBoundaryId,
      policy: structuredClone(state.policy),
      operationIds: [...new Set([...projected.operationIds, ...owner.pendingOperationIds])].slice(
        -100,
      ),
    },
  };
}
