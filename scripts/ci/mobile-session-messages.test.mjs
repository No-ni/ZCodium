import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { fileURLToPath } from "node:url";
const { zcodeSessionMessagesResultSchema } = await tsImport(
  "../../packages/shared/src/index.ts",
  import.meta.url,
);

const { readMessages } = await tsImport(
  "../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts",
  {
    parentURL: import.meta.url,
    tsconfig: fileURLToPath(new URL("./tsconfig.mobile-session-tests.json", import.meta.url)),
  },
);
const messages = ["user", "assistant"].map((role, index) => ({
  info: {
    id: `message-${index}`,
    sessionID: "fixture-session",
    role,
    agent: "fixture",
    time: { created: index + 1 },
    ...(role === "assistant"
      ? {
          parentID: "message-0",
          path: { cwd: "/fixture", root: "/fixture" },
          cost: 0,
          tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
        }
      : {}),
  },
  parts: [
    {
      id: `part-${index}`,
      messageID: `message-${index}`,
      sessionID: "fixture-session",
      type: "text",
      text: role === "user" ? "测试输入" : "测试回复",
    },
  ],
}));
const context = {
  sessions: new Map([
    [
      "fixture-session",
      { app: { sessionId: "fixture-session" }, eventStore: { getEvents: async () => [] } },
    ],
  ]),
  deps: { sessionStore: { messages: async () => messages, getSession: async () => null } },
};

test("手机读取非空历史符合协议 schema，消息 ID 与 part ID 不泄露存储字段", async () => {
  assert.equal(
    zcodeSessionMessagesResultSchema.safeParse({ messages }).success,
    false,
    "旧实现直接返回存储对象必定校验失败",
  );
  const result = zcodeSessionMessagesResultSchema.parse(
    await readMessages(context, { sessionId: "fixture-session" }),
  );
  assert.deepEqual(
    result.messages.map((message) => message.info.messageId),
    ["message-0", "message-1"],
  );
  assert.equal(result.messages[1].parts[0].partId, "part-1");
  assert.equal(result.messages[1].info.parentMessageId, "message-0");
  assert.equal("id" in result.messages[0].info, false);
  assert.equal("messageID" in result.messages[0].parts[0], false);
});

test("工具 part 复用协议映射，不泄漏存储 messageID/callID", async () => {
  messages[1].parts.push({
    id: "fixture-tool-part",
    messageID: "message-1",
    sessionID: "fixture-session",
    type: "tool",
    callID: "fixture-call",
    tool: "fixture_tool",
    state: {
      status: "completed",
      input: {},
      output: "fixture result",
      title: "fixture",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  });
  try {
    const result = zcodeSessionMessagesResultSchema.parse(
      await readMessages(context, { sessionId: "fixture-session" }),
    );
    assert.equal(result.messages[1].parts[1].callId, "fixture-call");
    assert.equal(result.messages[1].parts[1].state.output, "fixture result");
  } finally {
    messages[1].parts.pop();
  }
});

test("协议映射后仍保留 afterMessageId 和尾部 limit 的顺序", async () => {
  for (const params of [{ afterMessageId: "message-0" }, { limit: 1 }]) {
    const result = zcodeSessionMessagesResultSchema.parse(
      await readMessages(context, { sessionId: "fixture-session", ...params }),
    );
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].info.messageId, "message-1");
    assert.equal(result.messages[0].parts[0].text, "测试回复");
  }
});
