import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // 根 CI 无 UI alias；限定留白套件入口，避免把 node:test 套件交给 Vitest。
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "node",
    include: [
      "packages/ui/test/workflowHoles.test.ts",
      "packages/ui/test/workflowHoleOnlySurfaces.test.ts",
    ],
  },
});
