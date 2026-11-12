import { defaultConfig, type Config } from "acp-kernel";
import type {
  NativeContextParameters,
  NativeContextThreshold,
} from "@zcode/shared/native-context-compression";
export const nativeThresholdTokens = (
  threshold: NativeContextThreshold,
  inputBudget: number,
): number =>
  threshold.kind === "tokens" ? threshold.value : Math.floor((inputBudget * threshold.value) / 100);
export const nativeBenefitFloor = (
  parameters: NativeContextParameters,
  inputBudget: number,
): number =>
  parameters.trigger.minBenefitTokens === "auto"
    ? Math.max(200, Math.floor(inputBudget * 0.01))
    : parameters.trigger.minBenefitTokens;
export function nativeGrowthFloor(
  parameters: NativeContextParameters,
  inputBudget: number,
  tier: 1 | 2 | 3 = 1,
): number {
  const override = parameters.trigger.tierGrowthTokens[`t${tier}` as "t1" | "t2" | "t3"];
  if (override !== "auto") return override;
  const adaptive = parameters.trigger.adaptive;
  const base =
    parameters.trigger.growthMode === "constant"
      ? parameters.trigger.growthTokens
      : Math.min(
          adaptive.capTokens,
          Math.max(
            adaptive.floorTokens,
            Math.floor((inputBudget * adaptive.ratioPercent) / 100),
            adaptive.minGrowthFloorTokens,
            Math.floor((inputBudget * adaptive.minGrowthRatioPercent) / 100),
          ),
        );
  return Math.floor(base * (tier === 1 ? 1 : adaptive.tierMultiplier ** (tier - 1)));
}
/** 只消费库的纯 apply primitive；不启用其默认 emergency/CCR/rule owners。 */
export function nativeKernelConfig(
  parameters: NativeContextParameters,
  inputBudget: number,
  protectedIds: ReadonlySet<string>,
): Config {
  return defaultConfig(Math.max(1, inputBudget), {
    tiers: {
      enabled: parameters.summary.tiersEnabled,
      tier2Trigger: parameters.summary.tier2BlockCount,
      tier3Trigger: parameters.summary.tier3BlockCount,
    },
    promotionThreshold: parameters.summary.promotionSurvivals,
    compress: {
      minCompressRange: parameters.summary.minRangeChars,
      minSummaryLength: parameters.summary.minChars,
      maxSummaryLength: parameters.summary.maxChars,
    },
    protectedTools: parameters.history.protectedTools,
    protectedLatestTools: parameters.history.protectedLatestTools,
    neverPreserveRecentTools: parameters.history.earlyFoldTools,
    preserveRecentTools: parameters.history.preserveRecentTools,
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    isMessageProtected: (message) => protectedIds.has(message.id),
    isCompressTool: (name) => name === "context_compress",
    absorb: {
      enabled: false,
      toolName: "context_compress",
      minToolTokens: 0,
      contextThresholdPct: 0,
      excludeTools: [],
    },
    ccr: {
      enabled: false,
      toolName: "context_read",
      minToolTokens: 0,
      maxHeadChars: 0,
      excludeTools: [],
    },
    crush: { enabled: false, minReduction: 0 },
    rules: { enabled: false },
  });
}
