import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("真实 Host 列表在自动续跑边界保留手机运行状态", { timeout: 90_000 }, async (t) => {
  // Host 只消费内存 task index 和 sessions-index；所有子进程写入限制在项目沙箱。
  const result = await runSourceTests([
    "scripts/ci/fixtures/session-list-live-status-runtime.test.mjs",
  ]);
  assert.equal(result.tests, 17);
  t.diagnostic(`17 scenarios; sandbox=${result.sandboxRoot}`);
});
