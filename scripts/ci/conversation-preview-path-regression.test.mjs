import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("正文预览路径的 URL、UNC 与工作区词法边界回归", async (t) => {
  const result = await runSourceTests([
    "packages/shared/test/conversationPreviewPathBoundaries.test.ts",
  ]);
  // 独立隔离子进程必须执行实际导出的正反对照，不能只证明文件存在。
  assert.ok(result.tests >= 33, "预览路径回归至少执行 33 项测试");
  t.diagnostic(`${result.tests} tests executed`);
});
