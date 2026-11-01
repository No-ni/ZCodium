import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("generateText 取消的结算观察回归", async (t) => {
  const result = await runSourceTests([
    "apps/zcode-cli/packages/adapters/test/model-generate-abort-settlement.test.ts",
  ]);
  // 对真实 runGenerateText + fixture runtime 在 Node 默认严格拒绝模式下取证：
  // Stop 落在启动状态发布窗口时迟到拒绝被观察且归类取消不重试、迟到 fulfill 不覆盖取消、
  // midflight abort 有界事件 turn 内立即终结且迟到拒绝被观察、无 signal 成败语义不变、
  // signal 在场不 abort 成功不变，共 6 项；旧实现因场景一无 handler 使子进程转
  // uncaughtException（红），由隔离子进程传播失败，不能只检查测试文件存在。
  assert.equal(result.tests, 6);
  assert.match(result.stdout, /^# pass 6$/m);
  assert.match(result.stdout, /^# fail 0$/m);
  assert.match(result.stdout, /^# skipped 0$/m);
  t.diagnostic(`${result.tests} tests executed`);
});
