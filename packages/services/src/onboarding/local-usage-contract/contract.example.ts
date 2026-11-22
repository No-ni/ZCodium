import type { OnboardingLocalUsageEntry } from "./contract.js";
/** 沿既有 API 调用，不建立新的持久化或状态所有者。 */
export async function exampleOnboardingLocalUsage(
  api: OnboardingLocalUsageEntry,
  options: Parameters<OnboardingLocalUsageEntry["resolveAgentSessionDbPath"]>[0],
) {
  const path = await api.resolveAgentSessionDbPath(options);
  return path ? api.hasAnyAgentSessionRow(path) : false;
}
