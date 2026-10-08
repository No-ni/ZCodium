import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

// 逐文件等待并核实执行，不能因一个动态导入失效而漏掉后续诊断回归。
// localOnlyWebview 已随功能删除，不再引用或恢复它。
for (const file of [
  "apps/zcode-cli/packages/bootstrap/test/local-observability.test.ts",
  "packages/ui/test/localDiagnostics.test.ts",
  "apps/zcode-cli/packages/bootstrap/test/local-measurements.test.ts",
  "apps/zcode-cli/packages/cli/test/direct-diagnostics.test.ts",
]) {
  test(`Local diagnostics: ${file}`, async (t) => {
    const { tests } = await runSourceTests([file], {
      tsconfig: "scripts/ci/tsconfig.observability-tests.json",
    });
    t.diagnostic(`${tests} tests executed`);
  });
}
