export const module = {
  id: "native-context-runtime",
  owner: "agent-runtime",
  requires: [
    "zcode-cli",
    "shared",
    "native-context-protocol",
    "native-context-original-image",
    "model-usage-observability",
  ],
} as const;
