import type { ModelInputMessage } from "@zcode/contracts";
import type {
  NativeContextOperation,
  NativeContextStoredState,
} from "@zcode/shared/native-context-compression";
import type { AgentRuntimeInternal } from "../internal.js";
import { prepareRuntimeProviderRequest } from "../helpers/runtime-provider-request-messages.js";
import type { NativeContextSafePoint, NativeContextOutcome } from "./contract.js";
import { NativeContextRuntimeError } from "./contract.js";
import {
  nativeOwner,
  kernelOf,
  writeNativeState,
  nativeStatus,
  publishNativeStatus,
} from "./state.js";
import { nativeOperation, finishNativeOperation, nativeRecordSources } from "./records.js";
import { nativeMaintenanceRanges, validateNativeSummaryCandidate } from "./candidates.js";
import type { NativeSummaryRange } from "./guards.js";
import { nativeOutputCandidates, type NativeOutputCandidate } from "./tool-views.js";
import { nativeCountTokens, nativeTextEstimate, nativeMeasurementScope } from "./measurements.js";
import { nativeThresholdTokens, nativeBenefitFloor } from "./kernel-config.js";
import { nativeHash } from "./identity.js";
import { projectNativeEntries } from "./projection.js";
import { bindNativeProjectionOperation } from "./projection-operations.js";
import {
  nativeMaintenanceModel,
  nativeMaintenanceOutputBudget,
  callNativeMaintenanceModel,
} from "./maintenance-model.js";
import { validateNativeModelThresholds } from "./budgets.js";
import {
  buildNativeMaintenanceMessages,
  buildNativeDecisionMessages,
  parseNativeMaintenanceResult,
  parseNativeDecisionResult,
} from "./maintenance-prompts.js";

function requestOf(
  runtime: AgentRuntimeInternal,
  input: NativeContextSafePoint,
  state: NativeContextStoredState,
) {
  return prepareRuntimeProviderRequest(runtime, {
    entries: projectNativeEntries(input.entries, state),
    model: input.model,
    tools: [...input.tools],
    registry: runtime.registry,
  }).request;
}
function staleReason(
  current: NativeContextStoredState,
  frozen: NativeContextStoredState,
): NativeContextOperation["reason"] {
  if (
    current.generation !== frozen.generation ||
    current.historyVersion !== frozen.historyVersion ||
    current.compactBoundaryId !== frozen.compactBoundaryId
  )
    return "history-changed";
  if (current.policy.policyVersion !== frozen.policy.policyVersion) return "policy-changed";
  if (nativeHash(JSON.stringify(current.kernel)) !== nativeHash(JSON.stringify(frozen.kernel)))
    return "history-changed";
  return null;
}
function boundedBatch(input: {
  state: NativeContextStoredState;
  ranges: NativeSummaryRange[];
  outputs: NativeOutputCandidate[];
  maximumInputTokens: number;
  currentTokens: number;
  targetTokens: number;
}): {
  ranges: NativeSummaryRange[];
  outputs: NativeOutputCandidate[];
  messages: ModelInputMessage[];
} {
  const ranges: NativeSummaryRange[] = [],
    outputs: NativeOutputCandidate[] = [];
  const build = () => buildNativeMaintenanceMessages({ ...input, ranges, outputs });
  const targetMass = Math.max(1, input.currentTokens - input.targetTokens);
  let mass = 0;
  for (const range of input.ranges) {
    if (ranges.length === 20 || (mass >= targetMass * 2 && ranges.length > 0)) break;
    ranges.push(range);
    if (nativeTextEstimate(build(), []) > input.maximumInputTokens) {
      ranges.pop();
      continue;
    }
    mass += range.tokens;
  }
  const covered = new Set(ranges.flatMap((range) => range.rawIds));
  for (const output of input.outputs) {
    if (outputs.length === 20) break;
    if (covered.has(output.rawId)) continue;
    outputs.push(output);
    if (nativeTextEstimate(build(), []) > input.maximumInputTokens) outputs.pop();
  }
  return { ranges, outputs, messages: build() };
}
function applyOutputSummaries(
  state: NativeContextStoredState,
  offered: readonly NativeOutputCandidate[],
  outputs: { ref: string; summary: string }[],
): string[] {
  const refs = new Set<string>(),
    affected: string[] = [];
  const parameters = state.policy.parameters.summary;
  for (const output of outputs) {
    const source = offered.find((item) => item.ref === output.ref);
    const summary = output.summary.trim();
    if (
      !source ||
      refs.has(output.ref) ||
      summary.length < parameters.minChars ||
      (parameters.maxChars > 0 && summary.length > parameters.maxChars)
    ) {
      throw new NativeContextRuntimeError("invalid-range", "invalid-summary");
    }
    refs.add(output.ref);
    const text = `${summary}\n[Original context ref=${source.ref}; read with context_read.]`;
    const before = nativeCountTokens(source.text),
      after = nativeCountTokens(text);
    if (
      after >= before ||
      ((before - after) / Math.max(1, before)) * 100 < parameters.minReductionPercent
    )
      throw new NativeContextRuntimeError("invalid-range", "no-benefit");
    kernelOf(state).views[source.rawId] = {
      kind: "distilled",
      text,
      policyVersion: state.policy.policyVersion,
    };
    affected.push(source.rawId);
  }
  return affected;
}
/** 一次安全点仅产生一个有界摘要批次；模型等待不占唯一状态写锁。 */
export async function runNativeMaintenance(
  runtime: AgentRuntimeInternal,
  input: NativeContextSafePoint,
  trigger: NativeContextOperation["trigger"],
  admitted?: NativeContextOperation,
  options: { opportunistic?: boolean; tokenCount?: number } = {},
): Promise<NativeContextOutcome> {
  const owner = nativeOwner(runtime),
    frozen = structuredClone(owner.state!);
  const operation = admitted
    ? {
        ...admitted,
        status: "running" as const,
        historyVersion: frozen.historyVersion,
        policyVersion: frozen.policy.policyVersion,
        segmentId: frozen.compactBoundaryId,
        anchorMessageId: runtime.latestConversationMessageId,
        anchorRequestSeq: frozen.requestSeq,
      }
    : nativeOperation(frozen, {
        kind: "summary",
        trigger,
        anchorMessageId: runtime.latestConversationMessageId,
      });
  owner.phase = "compressing";
  const cancellation = new AbortController();
  owner.cancellation = cancellation;
  owner.maintenanceStartedAt = Date.now();
  const signal = input.signal
    ? AbortSignal.any([input.signal, cancellation.signal])
    : cancellation.signal;
  const safePoint = { ...input, signal };
  let terminal: NativeContextOperation | undefined;
  let committingCandidate = false;
  const finish = async (
    status: NativeContextOperation["status"],
    reason: NativeContextOperation["reason"] = null,
  ) => {
    terminal = finishNativeOperation(operation, status, reason);
    if (
      owner.state?.generation === frozen.generation &&
      runtime.branchGeneration === frozen.generation
    )
      await writeNativeState(owner, () => undefined, { operations: [terminal] });
    return { status: nativeStatus(owner), operation: terminal };
  };
  try {
    await writeNativeState(owner, () => undefined, { operations: [operation] });
    if (signal.aborted) return await finish("cancelled", "cancelled");
    const primaryBudget = validateNativeModelThresholds(frozen.policy.parameters, input.model);
    if (primaryBudget === null) return await finish("no-benefit", "unsupported");
    const model = nativeMaintenanceModel(runtime, safePoint, frozen);
    operation.model = { providerId: model.providerId, modelId: model.modelId };
    const maxOutput = nativeMaintenanceOutputBudget(model, frozen);
    const maximumInput = Math.max(
      0,
      (model.properties.contextWindow ?? primaryBudget) - maxOutput - 1000,
    );
    const beforeRequest = requestOf(runtime, safePoint, frozen);
    const beforeText = nativeTextEstimate(beforeRequest.messages, beforeRequest.tools);
    operation.beforeEstimate =
      nativeMeasurementScope(beforeRequest.messages) === "complete" ? beforeText : null;
    const currentTokens = options.tokenCount ?? beforeText;
    const targetTokens = nativeThresholdTokens(
      frozen.policy.parameters.trigger.target,
      primaryBudget,
    );
    const startTokens = nativeThresholdTokens(
      frozen.policy.parameters.trigger.start,
      primaryBudget,
    );
    if (targetTokens >= startTokens) return await finish("no-benefit", "unsupported");
    const legalRanges = nativeMaintenanceRanges(input.entries, frozen, Math.max(1, maximumInput));
    const offeredOutputs = nativeOutputCandidates(
      input.entries,
      frozen,
      currentTokens,
      primaryBudget,
    );
    const batch = boundedBatch({
      state: frozen,
      ranges: legalRanges,
      outputs: offeredOutputs,
      maximumInputTokens: maximumInput,
      currentTokens,
      targetTokens,
    });
    if (!batch.ranges.length && !batch.outputs.length)
      return await finish(
        "no-benefit",
        legalRanges.length || offeredOutputs.length ? "capacity" : "no-range",
      );
    const potentialTokens =
      batch.ranges.reduce((sum, range) => sum + range.tokens, 0) +
      batch.outputs.reduce((sum, output) => sum + nativeCountTokens(output.text), 0);
    if (potentialTokens < nativeBenefitFloor(frozen.policy.parameters, primaryBudget))
      return await finish("no-benefit", "no-benefit");
    if (options.opportunistic && frozen.policy.parameters.trigger.modelDecides) {
      const decision = nativeOperation(frozen, {
        kind: "decision",
        trigger,
        model: { providerId: model.providerId, modelId: model.modelId },
      });
      await writeNativeState(owner, () => undefined, { operations: [decision] });
      let shouldCompress: boolean;
      try {
        const response = await callNativeMaintenanceModel(runtime, {
          safePoint,
          state: frozen,
          model,
          operation: decision,
          decision: true,
          messages: buildNativeDecisionMessages({
            currentTokens,
            targetTokens,
            rangeCount: batch.ranges.length,
            outputCount: batch.outputs.length,
            potentialTokens,
          }),
        });
        shouldCompress = parseNativeDecisionResult(response.result.text);
        await writeNativeState(owner, () => undefined, {
          operations: [
            finishNativeOperation(
              decision,
              shouldCompress ? "completed" : "no-benefit",
              shouldCompress ? null : "no-benefit",
            ),
          ],
        });
      } catch (error) {
        if (owner.state?.generation === frozen.generation)
          await writeNativeState(owner, () => undefined, {
            operations: [
              finishNativeOperation(
                decision,
                signal.aborted ? "cancelled" : "error",
                signal.aborted ? "cancelled" : "model-error",
              ),
            ],
          });
        throw error;
      }
      if (!shouldCompress) return await finish("no-benefit", "no-benefit");
      const obsolete = staleReason(owner.state!, frozen);
      if (obsolete) return await finish("obsolete", obsolete);
    }
    const response = await callNativeMaintenanceModel(runtime, {
      safePoint,
      state: frozen,
      model,
      operation,
      messages: batch.messages,
      outputs: batch.outputs,
    });
    const result = parseNativeMaintenanceResult(response.result.text);
    if (!result.ranges.length && !result.outputs.length)
      return await finish("no-benefit", "no-benefit");
    const candidate = result.ranges.length
      ? validateNativeSummaryCandidate({
          entries: input.entries,
          state: frozen,
          inputBudget: primaryBudget,
          ranges: result.ranges,
          legalRanges: batch.ranges,
        })
      : { state: structuredClone(frozen), blockIds: [], rawIds: [] };
    const outputIds = applyOutputSummaries(candidate.state, batch.outputs, result.outputs);
    const afterRequest = requestOf(runtime, safePoint, candidate.state);
    const afterText = nativeTextEstimate(afterRequest.messages, afterRequest.tools);
    if (
      afterText >= beforeText ||
      beforeText - afterText < nativeBenefitFloor(frozen.policy.parameters, primaryBudget)
    )
      return await finish("no-benefit", "no-benefit");
    operation.afterEstimate =
      nativeMeasurementScope(afterRequest.messages) === "complete" ? afterText : null;
    operation.blockIds = candidate.blockIds;
    operation.sources = nativeRecordSources(
      frozen.sources.filter(
        (source) => candidate.rawIds.includes(source.rawId) || outputIds.includes(source.rawId),
      ),
    );
    operation.summary = [
      ...result.ranges.map((range) => range.summary),
      ...result.outputs.map((output) => output.summary),
    ].join("\n\n");
    terminal = finishNativeOperation(operation, "completed");
    committingCandidate = true;
    await writeNativeState(
      owner,
      (next) => {
        if (signal.aborted) throw new NativeContextRuntimeError("conflict", "cancelled");
        const reason = staleReason(next, frozen);
        if (reason) throw new NativeContextRuntimeError("conflict", reason);
        next.kernel = candidate.state.kernel;
        bindNativeProjectionOperation(next, operation.operationId, {
          blockIds: candidate.blockIds,
          rawIds: outputIds,
        });
        next.lastMaintenanceTokens = afterText;
        next.roundsSinceMaintenance = 0;
        next.estimateHoldRounds = 0;
      },
      { operations: [terminal] },
    );
    committingCandidate = false;
    return { status: nativeStatus(owner), operation: terminal };
  } catch (error) {
    const reason = owner.state ? staleReason(owner.state, frozen) : "history-changed";
    if (reason) return await finish("obsolete", reason);
    if (signal.aborted) return await finish("cancelled", "cancelled");
    // 模型响应与净收益已确认；最终候选持久化失败不能归为模型失败。
    if (committingCandidate) return await finish("error", "storage-error");
    if (error instanceof NativeContextRuntimeError && error.code === "unavailable")
      return await finish(
        "no-benefit",
        error.reason === "maintenance-media-capacity" ? "capacity" : "unsupported",
      );
    if (error instanceof NativeContextRuntimeError && error.code === "invalid-range")
      return await finish(
        "no-benefit",
        error.reason === "no-benefit" ? "no-benefit" : "invalid-summary",
      );
    return await finish("error", "model-error");
  } finally {
    if (owner.cancellation === cancellation) {
      owner.cancellation = undefined;
      owner.maintenanceStartedAt = undefined;
      owner.phase = "idle";
      await publishNativeStatus(owner);
    }
  }
}
