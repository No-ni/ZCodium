import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("DelayedChannel 订阅周期所有权回归", async (t) => {
  const result = await runSourceTests(["packages/rpc/test/delayedChannelSubscription.test.ts"]);
  // 未订阅不触碰上游、首监听唯一订阅、最后退订释放、退订重订只新建一次、迟到结果不重建、
  // 旧周期迟到成功不夺槽位、旧周期迟到失败不杀新周期、disposer 抛错不阻断终态不逃逸、
  // 同步退订后迟到句柄立即释放、非合作上游补投不重复投递、拒绝与上游抛错不产生游离 rejection、
  // 多监听者只释放最后一个、真实通道两侧请求表归零、call 拒绝回调用方、
  // 只构造不 call 不 listen 时源拒绝也不逃逸，共 15 项纯内存回归；
  // 由隔离子进程传播失败，不能只检查测试文件存在。
  assert.ok(result.tests >= 15, "DelayedChannel 订阅所有权回归至少执行 15 项测试");
  t.diagnostic(`${result.tests} tests executed`);
});
