import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("分支列表读取停止复用全量 Git 状态快照", async (t) => {
  // 隔离子进程负责完整装载与失败传播；断言命令序列而非仅测试文件存在。
  const result = await runSourceTests(["packages/services/test/gitLocalBranchListIo.test.ts"]);
  // 确切计数：3 项 IO/行为断言 + 3 项公开边界，缺一即视为回归被削弱。
  assert.equal(result.tests, 6, "分支列表 IO 回归必须恰好执行 6 项测试");
  t.diagnostic(result.tests + " tests executed");
});
