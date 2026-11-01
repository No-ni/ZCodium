import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("工具结果投影解析预算回归", async (t) => {
  // 隔离子进程负责完整装载与失败传播；断言解析计数而非仅测试文件存在。
  const result = await runSourceTests([
    "packages/services/test/toolResultProjectionParseBudget.test.ts",
  ]);
  // 确切计数：大 JSON / 纯文本 / 空串 / 非字符串 / Agent JSON / agentId 含 content /
  // agentId 不含 content / 后台 ACK / ACK 变体 / async_launched JSON / backgrounded JSON /
  // scheduled 播种记忆 / success:false，缺一即视为回归被削弱。
  assert.equal(result.tests, 13, "工具结果解析预算回归必须恰好执行 13 项测试");
  t.diagnostic(result.tests + " tests executed");
});
