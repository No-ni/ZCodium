import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("会话自动续跑提醒与思考工时的真实投影、Host 摄入回归", async (t) => {
  // 被测投影只消费内存事件；Host 注入内存 Repo/Agent，不创建真实数据库或运行会话。
  // 共用 runner 校验路径并把 profile、缓存、日志与子进程 HOME/TEMP 绑定到项目沙箱。
  const result = await runSourceTests([
    "scripts/ci/fixtures/session-work-status-projection.test.mjs",
  ]);
  assert.equal(result.tests, 38);
  t.diagnostic(`38 scenarios; sandbox=${result.sandboxRoot}`);
});
