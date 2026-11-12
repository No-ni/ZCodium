import {
  getNativeContextParameterValue,
  nativeContextConfigurationSchema,
  type NativeContextConfiguration,
  type NativeContextParameterField,
  type NativeContextParameterPath,
  type NativeContextParameterValue,
} from "@zcode/shared/native-context-compression";
import type { NativeContextParameterDraft } from "../contract.js";

export function parameterText(value: Readonly<NativeContextParameterValue>): string {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object")
    return "kind" in value ? String(value.value) : JSON.stringify(value);
  return String(value);
}

export function isParameterDraftDirty(draft: NativeContextParameterDraft): boolean {
  return (
    draft.jsonPending ||
    Object.keys(draft.rawFields).length > 0 ||
    JSON.stringify(draft.configuration) !== JSON.stringify(draft.baseConfiguration)
  );
}

export function rawParameterIsValid(field: NativeContextParameterField, text: string): boolean {
  if (field.type !== "number" && field.type !== "auto-number" && field.type !== "threshold")
    return true;
  if (field.type === "auto-number" && text === "auto") return true;
  if (text.trim() === "") return false;
  const numeric = Number(text);
  return Number.isFinite(numeric) && (field.decimal === true || Number.isInteger(numeric));
}

export function parameterIssuePaths(
  configuration: NativeContextConfiguration,
): ReadonlySet<string> {
  const result = nativeContextConfigurationSchema.safeParse(configuration);
  return result.success
    ? new Set<string>()
    : new Set(
        result.error.issues.map((issue) => issue.path.join(".").replace(/^parameters\./, "")),
      );
}

/** 不启用的算法保留草稿值；禁用原因只影响输入，不改变实际策略。 */
export function parameterInactiveReason(
  configuration: NativeContextConfiguration,
  path: NativeContextParameterPath,
): string | null {
  const p = configuration.parameters;
  if (path === "trigger.growthTokens" && p.trigger.growthMode !== "constant") return "constant";
  if (path.startsWith("trigger.adaptive.") && p.trigger.growthMode !== "adaptive")
    return "adaptive";
  if (path === "trigger.estimateHoldRounds" && !p.trigger.waitForUsageSample) return "waitForUsage";
  if (path === "trigger.decisionMaxOutputTokens" && !p.trigger.modelDecides) return "modelDecides";
  if (
    (path === "summary.tier2BlockCount" ||
      path === "summary.tier3BlockCount" ||
      path === "summary.promotionSurvivals") &&
    !p.summary.tiersEnabled
  )
    return "tiers";
  if (path === "reasoning.thresholdChars" && p.reasoning.completedMode === "retain")
    return "reasoning";
  if (
    path.startsWith("tools.reference.") &&
    path !== "tools.reference.enabled" &&
    !p.tools.reference.enabled
  )
    return "reference";
  if (
    path.startsWith("tools.distill.") &&
    path !== "tools.distill.enabled" &&
    !p.tools.distill.enabled
  )
    return "distill";
  if (path.startsWith("tools.simplify.") && !p.tools.distill.enabled) return "distill";
  if (
    path.startsWith("tools.simplify.") &&
    path !== "tools.simplify.enabled" &&
    !p.tools.simplify.enabled
  )
    return "simplify";
  if (path === "images.keepRecentUserTurns" && !p.images.omitSeen) return "omitSeen";
  if (path === "images.convention.text" && !p.images.convention.enabled) return "imageConvention";
  if (
    path.startsWith("images.") &&
    ![
      "images.rescale",
      "images.foldWithHistory",
      "images.omitSeen",
      "images.keepRecentUserTurns",
      "images.convention.enabled",
      "images.convention.text",
    ].includes(path) &&
    !p.images.rescale
  )
    return "rescale";
  if (path === "images.byteTriggerKiB" && p.images.triggerMode !== "edge-or-bytes")
    return "byteGate";
  if (path === "images.flattenColor" && p.images.alphaMode !== "flatten") return "flatten";
  return null;
}

export function parameterEqualsRecommendation(
  configuration: NativeContextConfiguration,
  field: NativeContextParameterField,
): boolean {
  return (
    JSON.stringify(getNativeContextParameterValue(configuration.parameters, field.path)) ===
    JSON.stringify(field.value)
  );
}
