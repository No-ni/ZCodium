import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("SSH config alias 列表在途合并", async (t) => {
  // 隔离子进程负责完整装载与失败传播；断言确切执行计数，缺一即视为回归被削弱。
  // 6 项 TTL/缓存/拒绝语义 + 3 项在途单飞（并发 2→1 / 加入中途 / 共享拒绝）
  // + 1 项生产装配保持（真实 parse + 无 ssh fallback + 缓存接线 + 拷贝隔离）。
  const result = await runSourceTests(["packages/services/test/sshConfigAliasCatalog.test.ts"]);
  assert.equal(result.tests, 10, "SSH alias 单飞回归必须恰好执行 10 项测试");
  t.diagnostic(result.tests + " tests executed");
});
