export const module = {
  id: "native-context-image",
  requires: ["zcode-cli", "shared", "native-context-protocol"],
  publicEntrypoints: ["./contract.ts", "./index.ts"],
} as const;
