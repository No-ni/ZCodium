import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("自定义模型目录与大小写不敏感鉴权头回归", async (t) => {
  const result = await runSourceTests([
    "packages/services/test/providerModelCatalog.test.ts",
    "packages/services/test/providerModelCatalogHeaders.test.ts",
  ]);
  // 保留原有目录行为与新增鉴权边界覆盖；由隔离子进程传播失败，不能只检查测试文件存在。
  assert.ok(result.tests >= 26, "模型目录回归至少执行 26 项测试");
  t.diagnostic(`${result.tests} tests executed`);
});
