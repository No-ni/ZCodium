export const onboardingLocalUsageModule = {
  id: "onboarding-local-usage",
  requires: ["shared"],
  provides: ["onboarding-local-usage"],
  publicEntrypoints: ["contract.ts"],
} as const;
