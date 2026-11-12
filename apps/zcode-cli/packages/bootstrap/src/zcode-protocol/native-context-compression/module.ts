export const nativeContextBootstrapModule = {
  id: "native-context-bootstrap",
  requires: ["shared", "native-context-protocol", "zcode-cli"],
  provides: ["native-context-queries", "native-context-commands"],
  publicEntrypoints: ["index.ts", "contract.ts", "native-context.ts"],
} as const;
