import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("存储扫描启动作废在途启动意图", async (t) => {
  // 隔离子进程负责完整装载与失败传播；断言 runner.run 触达次数而非仅测试文件存在。
  const result = await runSourceTests([
    "packages/services/test/storageScanStartGeneration.test.ts",
  ]);
  // 确切计数：4 项作废路径（乱序接管/取消后启动/dispose 后启动/clean 后启动）
  // + 1 项守卫（未知/陈旧取消不得误杀在途启动）+ 2 项行为保持
  // （正常路径终态快照、取消态快照与未知取消 no-op），缺一即视为回归被削弱。
  assert.equal(result.tests, 7, "存储扫描启动代纪回归必须恰好执行 7 项测试");
  t.diagnostic(result.tests + " tests executed");
});
