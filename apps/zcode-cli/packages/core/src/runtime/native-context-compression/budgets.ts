import type { Model } from "@zcode/contracts";
import type { NativeContextParameters } from "@zcode/shared/native-context-compression";
import { resolveNormalRequestMaxOutputTokens } from "../methods/model-token-limits.js";
import { nativeThresholdTokens } from "./kernel-config.js";
import { NativeContextRuntimeError } from "./contract.js";

export function nativeInputBudget(model: Model): number | null {
  const window = model.properties.contextWindow;
  if (!window || !Number.isFinite(window) || window <= 0) return null;
  const budget =
    Math.floor(window) -
    resolveNormalRequestMaxOutputTokens({
      modelMaxOutputTokens: model.optionSpecs.maxOutputTokens.max,
    });
  return budget > 0 ? budget : null;
}
/** schema 无法比较混合单位；获得真实 ModelPort 后再验证同一输入预算。 */
export function validateNativeModelThresholds(
  parameters: NativeContextParameters,
  model: Model,
): number | null {
  const budget = nativeInputBudget(model);
  if (budget === null) return null;
  const start = nativeThresholdTokens(parameters.trigger.start, budget),
    target = nativeThresholdTokens(parameters.trigger.target, budget);
  if (target >= start)
    throw new NativeContextRuntimeError("invalid-state", "model-threshold-target");
  if (start > Math.floor((budget * parameters.trigger.capacityPercent) / 100))
    throw new NativeContextRuntimeError("invalid-state", "model-threshold-capacity");
  if (Math.floor((budget * parameters.trigger.opportunisticPercent) / 100) > start)
    throw new NativeContextRuntimeError("invalid-state", "model-threshold-opportunistic");
  return budget;
}
