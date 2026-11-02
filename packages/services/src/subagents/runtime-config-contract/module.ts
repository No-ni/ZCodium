export const subagentRuntimeConfigModule = {
  id: "subagent-runtime-config",
  requires: ["services", "shared"],
  provides: ["subagent-runtime-config"],
  publicEntrypoints: ["contract.ts"],
} as const;
