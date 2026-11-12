import type { NativeContextObservation } from "../contract.js";

export type NativeContextUsageKey =
  | "actualInputTokens"
  | "outputTokens"
  | "cacheReadTokens"
  | "cacheCreateTokens";

/** 已知部分和未知请求分开计数；空集合的零只表示本次已加载范围。 */
export function summarizeNativeContextUsage(
  observations: readonly NativeContextObservation[],
  key: NativeContextUsageKey,
): { value: number | null; unknown: number } {
  let total = 0;
  let known = 0;
  for (const observation of observations) {
    const value = observation[key];
    if (value === null) continue;
    total += value;
    known += 1;
  }
  return {
    value: observations.length === 0 || known > 0 ? total : null,
    unknown: observations.length - known,
  };
}
