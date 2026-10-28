import { defineConfig } from "vitest/config";
export default defineConfig({
  // 沙箱入口经 VITEST_CACHE_DIR 指向 fresh sandbox；缺省保持原 node_modules/.vite 位置不变。
  cacheDir: process.env.VITEST_CACHE_DIR ?? "node_modules/.vite",
  test: {
    include: ["*.test.ts", "src/**/*.test.ts", "ui/**/*.test.ts", "scripts/**/*.test.mjs"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
