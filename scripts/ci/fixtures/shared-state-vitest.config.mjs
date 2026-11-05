import { join } from "node:path";
import { defineConfig } from "vitest/config";
import { assertProjectPath, projectRoot } from "../project-test-sandbox.mjs";

const sandbox = await assertProjectPath(process.env.PROJECT_TEST_SANDBOX_ROOT ?? "");
const cacheDir = await assertProjectPath(join(sandbox, "cache", "shared-state-vitest"));

// App 单测已退出根工程发现；专项回归显式命名文件并将 Vite 缓存限定在项目子沙箱。
export default defineConfig({
  root: projectRoot,
  cacheDir,
  resolve: {
    alias: {
      "@": join(projectRoot, "packages/ui/src"),
      "@desktop": join(projectRoot, "packages/desktop/src"),
      "@web": join(projectRoot, "packages/web/src"),
    },
  },
  test: {
    setupFiles: [join(projectRoot, "vitest.setup.ts")],
    include: [
      "packages/server/src/remote/sshKnownHosts.test.ts",
      "packages/server/src/remote/sshBackendHostKey.test.ts",
      "packages/server/src/remote/sshHostVerificationLifecycle.test.ts",
      "packages/services/test/mcpLegacyMigration.test.ts",
      "packages/services/test/sharedConfigMutations.test.ts",
    ],
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 1,
    hookTimeout: 30_000,
    testTimeout: 30_000,
    silent: "passed-only",
  },
});
