import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("IPCServer 连接 scope 与未路由调用路由等待回归", async (t) => {
  const result = await runSourceTests([
    "packages/rpc/test/ipcServerOwnership.test.ts",
    "packages/rpc/test/ipcServerRouting.test.ts",
  ]);
  // 连接 scope 所有权 8 项 + 路由等待取消所有权 23 项，共 31 项纯内存回归；
  // 由隔离子进程传播失败，不能只检查测试文件存在。
  assert.ok(result.tests >= 31, "IPC 生命周期回归至少执行 31 项测试");
  t.diagnostic(`${result.tests} tests executed`);
});
