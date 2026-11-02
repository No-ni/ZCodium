import { runSourceTests } from "../../../scripts/ci/source-test-runner.mjs";

// 本仓更新源由构建时显式配置；官方默认源、OAuth 回调和 Linux AppImage 场景已退休。
// 此入口验证源码边界，产物签名和安装流程仍需分别在目标设备验收。
const result = await runSourceTests([
  "scripts/ci/update-source-ownership.test.mjs",
  "scripts/ci/audit-boundaries.test.mjs",
]);
console.log(result.stdout);
console.log(`Evidence: ${result.logPath}`);
