export const serverDockerArgumentsModule = {
  id: "server-docker-arguments",
  requires: ["shared"],
  provides: ["server-docker-arguments"],
  publicEntrypoints: ["contract.ts"],
} as const;
