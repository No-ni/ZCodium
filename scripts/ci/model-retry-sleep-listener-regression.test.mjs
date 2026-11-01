import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("模型退避 sleep 的 abort 监听生命周期回归", async (t) => {
  const result = await runSourceTests([
    "apps/zcode-cli/packages/adapters/test/model-retry-sleep-listener-lifecycle.test.ts",
  ]);
  // 直接对生产 sleep 与真实 generateText 空完成重试路径取证：正常睡满 N 次后监听归零、
  // 退避中 abort 以 signal.reason 立即拒绝且监听归零、abort 清除未决 timer、pre-aborted、
  // 无 signal、delayMs<=0 的返回与拒绝、非 Error reason 的 AbortError 形状、
  // generateText 空完成重试退避结束后请求 signal 监听归零，共 9 项纯内存回归；
  // 由隔离子进程传播失败，不能只检查测试文件存在。
  assert.equal(result.tests, 9);
  assert.match(result.stdout, /^# pass 9$/m);
  assert.match(result.stdout, /^# fail 0$/m);
  assert.match(result.stdout, /^# skipped 0$/m);
  t.diagnostic(`${result.tests} tests executed`);
});
