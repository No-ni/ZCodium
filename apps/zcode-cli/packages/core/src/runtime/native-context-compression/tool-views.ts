import { crushText, jsonFoldPlugin, codeTrimPlugin, logSelectPlugin } from "acp-kernel";
import type {
  NativeContextStoredState,
  NativeContextSource,
} from "@zcode/shared/native-context-compression";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import { nativeToolMatches } from "./guards.js";
import { nativeEntryText, nativeRawId } from "./identity.js";
import { nativeCountTokens } from "./measurements.js";
import { kernelOf } from "./state.js";
import { nativeProtectedToolGroups } from "./soft-protection.js";

function eligibleNativeDistillation(
  entry: RuntimeMessageEntry,
  text: string,
  state: NativeContextStoredState,
  currentTokens: number,
  inputBudget: number,
): boolean {
  const policy = state.policy.parameters.tools.distill;
  if (
    entry.kind === "attachment" ||
    !policy.enabled ||
    (currentTokens / inputBudget) * 100 < policy.minContextPercent ||
    nativeToolMatches(entry.message.toolName, policy.excludeTools)
  )
    return false;
  const hasImage =
    Array.isArray(entry.message.content) &&
    entry.message.content.some((block) => block.type === "image");
  return policy.mediaOnly ? hasImage : nativeCountTokens(text) >= policy.minTokens;
}

export interface NativeOutputCandidate {
  rawId: string;
  ref: string;
  text: string;
  entry: RuntimeMessageEntry;
  source: NativeContextSource;
}
export function nativeOutputCandidates(
  entries: readonly RuntimeMessageEntry[],
  state: NativeContextStoredState,
  currentTokens: number,
  inputBudget: number,
): NativeOutputCandidate[] {
  const tools = state.policy.parameters.tools;
  if (
    !tools.distill.enabled ||
    (currentTokens / inputBudget) * 100 < tools.distill.minContextPercent
  )
    return [];
  const sources = new Map(state.sources.map((item) => [item.rawId, item]));
  const views = kernelOf(state).views;
  const protectedGroups = nativeProtectedToolGroups(entries, state);
  return entries.flatMap((entry): NativeOutputCandidate[] => {
    const rawId = nativeRawId(entry);
    const source = rawId ? sources.get(rawId) : undefined;
    if (
      entry.kind === "attachment" ||
      entry.message.role !== "tool" ||
      !rawId ||
      !source?.originalAvailable ||
      views[rawId]?.kind === "distilled" ||
      views[rawId]?.kind === "reference"
    )
      return [];
    const name = entry.message.toolName;
    if (
      protectedGroups.has(source.messageId) ||
      nativeToolMatches(name, tools.distill.excludeTools)
    )
      return [];
    const text = views[rawId]?.kind === "simplified" ? views[rawId].text : nativeEntryText(entry);
    if (!eligibleNativeDistillation(entry, text, state, currentTokens, inputBudget)) return [];
    return [{ rawId, ref: source.ref, text, entry, source }];
  });
}
/** 简化、引用和省略都只提交一次；修改策略不会反复重写已经生效的前缀。 */
export function applyNativeToolViews(
  state: NativeContextStoredState,
  entries: readonly RuntimeMessageEntry[],
  pressure?: { currentTokens: number; inputBudget: number },
): NativeContextSource[] {
  const affected: NativeContextSource[] = [];
  const parameters = state.policy.parameters;
  const kernel = kernelOf(state);
  const sources = new Map(state.sources.map((source) => [source.rawId, source]));
  const protectedGroups = nativeProtectedToolGroups(entries, state);
  const plugins = [
    ["json-fold", jsonFoldPlugin],
    ["code-trim", codeTrimPlugin],
    ["log-select", logSelectPlugin],
  ] as const;
  for (const entry of entries) {
    const rawId = nativeRawId(entry);
    if (entry.kind === "attachment" || !rawId) continue;
    if (
      entry.message.role === "assistant" &&
      parameters.reasoning.completedMode === "provider-safe-omit" &&
      Array.isArray(entry.message.content) &&
      entry.message.content.some(
        (block) =>
          block.type === "reasoning" &&
          block.text.length >= parameters.reasoning.thresholdChars &&
          (!block.providerOptions || Object.keys(block.providerOptions).length === 0),
      )
    ) {
      kernel.omittedReasoningIds ??= [];
      if (!kernel.omittedReasoningIds.includes(rawId)) kernel.omittedReasoningIds.push(rawId);
    }
    const source = sources.get(rawId);
    if (
      entry.message.role !== "tool" ||
      !source?.originalAvailable ||
      kernel.views[rawId] ||
      protectedGroups.has(source.messageId)
    )
      continue;
    const original = nativeEntryText(entry);
    const pointer = `\n[Original context ref=${source.ref}; read with context_read.]`;
    const tokens = nativeCountTokens(original);
    if (parameters.tools.simplify.enabled) {
      const available = plugins
        .filter(
          ([name]) =>
            parameters.tools.simplify.strategies[name].enabled &&
            !nativeToolMatches(
              entry.message.toolName,
              parameters.tools.simplify.strategies[name].excludeTools,
            ),
        )
        .map(([, plugin]) => plugin);
      const simplified = crushText(original, {
        minReduction: parameters.tools.simplify.minReductionPercent / 100,
        countTokens: nativeCountTokens,
        meta: { toolName: entry.message.toolName },
        plugins: available,
      });
      if (simplified && nativeCountTokens(simplified.text + pointer) < tokens) {
        kernel.views[rawId] = {
          kind: "simplified",
          text: simplified.text + pointer,
          policyVersion: state.policy.policyVersion,
        };
        affected.push(source);
        continue;
      }
    }
    // 提炼达到用户设定条件时先保留完整候选，不能先 reference 后永久排除付费摘要。
    if (
      pressure &&
      eligibleNativeDistillation(
        entry,
        original,
        state,
        pressure.currentTokens,
        pressure.inputBudget,
      )
    )
      continue;
    const reference = parameters.tools.reference;
    if (
      reference.enabled &&
      tokens >= reference.minTokens &&
      !nativeToolMatches(entry.message.toolName, reference.excludeTools)
    ) {
      const text = `${original.slice(0, reference.headChars)}${pointer}`;
      if (nativeCountTokens(text) < tokens) {
        kernel.views[rawId] = {
          kind: "reference",
          text,
          policyVersion: state.policy.policyVersion,
        };
        affected.push(source);
      }
    }
  }
  return affected;
}
