import { activeBlocks, advanceSurvival, createCore } from "acp-kernel";
import type { NativeContextStoredState } from "@zcode/shared/native-context-compression";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import { NativeContextRuntimeError } from "./contract.js";
import { coreMessagesOf } from "./sources.js";
import {
  nativeSummaryRanges,
  protectedNativeIds,
  nativeMessageId,
  type NativeSummaryRange,
} from "./guards.js";
import { nativeKernelConfig, nativeBenefitFloor } from "./kernel-config.js";
import { kernelOf } from "./state.js";
import { nativeCountTokens } from "./measurements.js";
import { nativeRawId } from "./identity.js";
import { splitNativeRange } from "./range-batches.js";

export function nativeMaintenanceRanges(
  entries: readonly RuntimeMessageEntry[],
  state: NativeContextStoredState,
  inputBudget?: number,
): NativeSummaryRange[] {
  const originalRanges = nativeSummaryRanges(entries, state, nativeCountTokens);
  const ranges = inputBudget
    ? originalRanges.flatMap((range) =>
        splitNativeRange(
          range.entries,
          state,
          Math.max(1, Math.min(12_000, Math.floor(inputBudget * 0.45))),
        ),
      )
    : originalRanges;
  if (!state.policy.parameters.summary.tiersEnabled) return ranges;
  const blocks = activeBlocks(kernelOf(state).compression);
  const parameters = state.policy.parameters.summary;
  for (const tier of [2, 3] as const) {
    const candidates = blocks.filter(
      (block) => block.tier === tier - 1 && block.survivedCount >= parameters.promotionSurvivals,
    );
    const minimum = tier === 2 ? parameters.tier2BlockCount : parameters.tier3BlockCount;
    if (candidates.length < minimum) continue;
    const selected = candidates.slice(0, minimum);
    ranges.push({
      entries: [],
      rawIds: selected.flatMap((block) => block.effectiveMessageIds),
      blockIds: selected.map((block) => block.blockId),
      tier,
      startRef: selected[0]!.blockId,
      endRef: selected.at(-1)!.blockId,
      tokens: selected.reduce((sum, block) => sum + nativeCountTokens(block.summary), 0),
      chars: selected.reduce((sum, block) => sum + block.summary.length, 0),
    });
  }
  return ranges;
}
export function validateNativeSummaryCandidate(input: {
  entries: readonly RuntimeMessageEntry[];
  state: NativeContextStoredState;
  inputBudget: number;
  ranges: { startRef: string; endRef: string; summary: string }[];
  legalRanges?: NativeSummaryRange[];
}): { state: NativeContextStoredState; blockIds: string[]; rawIds: string[] } {
  const { entries, state, inputBudget } = input;
  const legal = input.legalRanges ?? nativeMaintenanceRanges(entries, state, inputBudget);
  const accepted = input.ranges.map((range) => {
    const match = legal.find(
      (item) => item.startRef === range.startRef && item.endRef === range.endRef,
    );
    if (!match) throw new NativeContextRuntimeError("invalid-range", "incomplete-range");
    const summary = range.summary.trim();
    const parameters = state.policy.parameters.summary;
    if (
      summary.length < parameters.minChars ||
      (parameters.maxChars > 0 && summary.length > parameters.maxChars) ||
      nativeCountTokens(summary) >= match.tokens ||
      ((match.tokens - nativeCountTokens(summary)) / Math.max(1, match.tokens)) * 100 <
        parameters.minReductionPercent
    ) {
      throw new NativeContextRuntimeError("invalid-range", "invalid-summary");
    }
    return { ...range, summary, match };
  });
  const allRawIds = accepted.flatMap((item) => item.match.rawIds);
  if (new Set(allRawIds).size !== allRawIds.length)
    throw new NativeContextRuntimeError("invalid-range", "overlapping-ranges");
  if (
    !accepted.length ||
    accepted.reduce((sum, item) => sum + item.match.tokens - nativeCountTokens(item.summary), 0) <
      nativeBenefitFloor(state.policy.parameters, inputBudget)
  ) {
    throw new NativeContextRuntimeError("invalid-range", "no-benefit");
  }
  const candidate = structuredClone(state);
  const beforeBlocks = new Set(
    kernelOf(candidate).compression.blocks.map((block) => block.blockId),
  );
  const protectedIds = protectedNativeIds(entries, state, nativeCountTokens);
  const result = createCore({ countTokens: nativeCountTokens }).applyCompression({
    messages: coreMessagesOf(entries, candidate),
    state: kernelOf(candidate).compression,
    config: nativeKernelConfig(state.policy.parameters, inputBudget, protectedIds),
    protectedMessageIds: protectedIds,
    ranges: accepted.map(({ match: _match, ...range }) => range),
  });
  if (result.result.errors.length || !result.result.blocksCreated)
    throw new NativeContextRuntimeError("invalid-range", "invalid-summary");
  // 内核把 # fragments 按 persisted message 归组；任何半组结果都必须整体拒绝。
  const expected = new Set(accepted.flatMap((item) => item.match.rawIds).map(nativeMessageId));
  const newBlocks = result.state.blocks.filter((block) => !beforeBlocks.has(block.blockId));
  const effective = new Set(
    newBlocks.flatMap((block) => block.effectiveMessageIds).map(nativeMessageId),
  );
  if (expected.size !== effective.size || [...expected].some((id) => !effective.has(id)))
    throw new NativeContextRuntimeError("invalid-range", "incomplete-coverage");
  const allCores = coreMessagesOf(entries, state);
  for (const groupId of effective) {
    if (allCores.some((core) => nativeMessageId(core.id) === groupId && protectedIds.has(core.id)))
      throw new NativeContextRuntimeError("invalid-range", "protected-group");
  }
  kernelOf(candidate).compression = result.state;
  return {
    state: candidate,
    blockIds: newBlocks.map((block) => block.blockId),
    rawIds: [...new Set(accepted.flatMap((item) => item.match.rawIds))],
  };
}
export function advanceNativeSurvival(state: NativeContextStoredState): void {
  advanceSurvival(kernelOf(state).compression, state.policy.parameters.summary.promotionSurvivals);
}
export function nativeRangeText(
  range: NativeSummaryRange,
  state: NativeContextStoredState,
): string {
  if (range.blockIds)
    return range.blockIds
      .map((id) => {
        const block = kernelOf(state).compression.blocks.find((item) => item.blockId === id)!;
        return `[${id}]\n${block.summary}`;
      })
      .join("\n\n");
  return range.entries
    .map((entry) => {
      const raw = nativeRawId(entry)!;
      const ref = kernelOf(state).compression.messageRefs.byRaw[raw];
      const text = coreMessagesOf([entry], state)
        .map((item) => item.text ?? "")
        .join("\n");
      const timestamp =
        state.policy.parameters.prompts.messageTimestamps && entry.canonical
          ? ` firstSeen=${entry.canonical.createdAt}`
          : "";
      return `[${ref} ${entry.kind === "attachment" ? "attachment" : entry.message.role}${timestamp}]\n${text}`;
    })
    .join("\n\n");
}
