export const DEFAULT_E2E_DESKTOP_BUILD_INPUTS = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.production.local",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "packages/desktop/scripts/build-metadata.mjs",
  "scripts/builtin-provider-config.mjs",
  "config/provider/zcode-builtin.json",
  "packages/provider-node/src/zcode-builtin-release.ts",
  "packages/desktop/scripts/run-production-build.mjs",
  "packages/desktop/tsconfig.json",
  "packages/desktop/tsconfig.host.json",
  "packages/desktop/tsconfig.main.json",
  "packages/desktop/tsconfig.preload.json",
  "packages/desktop/tsconfig.renderer.json",
  "packages/desktop/tsconfig.scheduler.json",
  "packages/desktop/tsconfig.extension-host.json",
  "packages/desktop/tsup.config.ts",
  "packages/desktop/vite.config.ts",
];

export const E2E_DESKTOP_BUILD_ENV_NAMES = [
  "CDN_DOMAIN",
  // Bugfix: tsup 会根据 CI 分支或 Tag 判断是否为正式发布构建；这些值必须参与缓存指纹，
  // 否则可能把未注入 Agent OTLP 配置的普通构建错误复用到发布场景。
  "CI",
  "CI_COMMIT_BRANCH",
  "CI_COMMIT_TAG",
  "NODE_ENV",
  "OSS_PATH_PREFIX",
  "VITE_ZCODE_BASE_URL",
  "VITE_ZCODE_E2E_STORE_BRIDGE",
  "VITE_ZCODE_ENDPOINT_ORIGIN",
  // 本 fork 无官方账号/套餐/邀请 webview 面：这些 define 已从 tsup/vite 移除，
  // 继续参与指纹只会让缓存清单声称不存在的构建输入。
  "ZCODE_AUTO_UPDATE",
  "ZCODE_BASE_URL",
  "ZCODE_COMMIT",
  "ZCODE_CUA_HELPER_BUILD_ID",
  "ZCODE_ENDPOINT_ORIGIN",
  "ZCODE_ENV",
  "ZCODE_E2E_COVERAGE",
  "ZCODE_E2E_KEEP_BUILD_CACHE",
  "ZCODE_PACKAGED_AGENT_OTEL_ENDPOINT",
  "ZCODE_PACKAGED_AGENT_OTEL_HEADERS",
  "ZCODE_PACKAGED_AGENT_OTEL_SERVICE_NAME",
  "ZCODE_PRODUCTION_BASE_URL",
  "ZCODE_TEST_BASE_URL",
  // 自有更新源与显式自动更新开关会改变注入产物，必须让缓存失效，否则换源后复用旧 bundle。
  "ZCODIUM_UPDATE_ORIGIN",
];

/**
 * E2E 桌面包固定按 test 环境构建。
 *
 * bug 根因：从 ZCode 客户端拉起的 shell 里带有应用自身环境（实测 ZCODE_ENV=production、
 * ZCODE_BASE_URL=https://zcode.z.ai）。这些变量被 tsup 当作构建输入编译进 main/host 包，
 * 于是 `resolveZCodeEndpointOrigin` 走 production 分支、忽略 settings 里的 endpoint，
 * spec 用 fixture 起的本地 mock server 全部收不到请求，表现为大批配置类用例失败。
 * 构建前统一归一，runner 与本脚本共用同一结果；ZCODE_BASE_URL 等运行时变量也不能进入构建。
 */
export const E2E_DESKTOP_BUILD_INHERITED_ENV_NAMES = [
  "ZCODE_BASE_URL",
  "ZCODE_RUNTIME_ENV",
  "ZCODE_APP_VERSION",
  "ZCODE_BUILD_COMMIT_ID",
  "ZCODE_PROCESS_LABEL",
  "ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED",
  "ZCODE_CUA_BUNDLED_HELPER_APP_PATH",
  "ZCODE_CUA_LAUNCHER_PID",
];

export function normalizeE2EDesktopBuildEnv(env = process.env) {
  const normalized = { ...env, ZCODE_ENV: "test" };
  for (const name of E2E_DESKTOP_BUILD_INHERITED_ENV_NAMES) {
    delete normalized[name];
  }
  return normalized;
}
