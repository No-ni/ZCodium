import assert from "node:assert/strict";
import test from "node:test";
import { runSourceTests } from "./source-test-runner.mjs";

test("Bot 长文本分片代理对回归", async (t) => {
  // 隔离子进程负责完整装载与失败传播；真实 provider.send / extractBotAssistantResponseMessages
  // 入口 + stub，断言分片形状而非仅测试文件存在。
  const result = await runSourceTests(["packages/services/test/botLongTextSplitUnicode.test.ts"]);
  // 确切计数：telegram 6（边界×3 / 非边界 / 空文本 / 既有孤立代理）+ markup 1 +
  // feishu 5（边界×2 / BMP / 空文本 / 既有孤立代理）+ splitLongReplyText 4（边界 / BMP 差分 / 既有孤立代理 / 空串）。
  assert.equal(result.tests, 16, "Bot 长文本分片回归必须恰好执行 16 项测试");
  t.diagnostic(result.tests + " tests executed");
});
