export const e2eReportModule = {
  id: "e2e-report",
  requires: [],
  provides: ["e2e-report"],
  publicEntrypoints: ["index.ts", "contract.ts", "node/index.ts", "shared/types.ts"],
} as const;
