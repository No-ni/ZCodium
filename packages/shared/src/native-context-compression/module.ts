export const module = {
  id: "native-context-protocol",
  requires: ["shared"],
  publicEntrypoints: ["./contract.ts", "./index.ts"],
} as const;
