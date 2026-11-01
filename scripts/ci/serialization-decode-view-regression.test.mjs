import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("RPC String/Object 反序列化零拷贝即时解码回归", async (t) => {
  const result = await runSourceTests(["packages/rpc/test/serializationDecodeViews.test.ts"]);
  // String/Object 拷贝预算（含内容校验与 diagnostic 实测字节）、Buffer/VSBuffer 变异隔离、
  // readString 游标归一、负 bytes 相对末端归一、readByte 越界后 readString 不倒退、
  // 非零 offset 子视图、UTF-8 与连续多值等价、普通 IReader 回退、readString 优先探测、
  // slice/read 既有语义不变，共 10 项纯内存回归；由隔离子进程传播失败，不能只检查测试文件存在。
  assert.equal(result.tests, 10);
  t.diagnostic(`${result.tests} tests executed`);
});
