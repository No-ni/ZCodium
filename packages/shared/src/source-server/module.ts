export const module = {
  id: "source-server-protocol",
  requires: ["shared"],
  publicEntrypoints: ["./contract.ts", "./index.ts"],
} as const;
