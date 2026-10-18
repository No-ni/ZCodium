import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { createMobileMessages, longText } from "./fixtures/mobile-remote-layout.mjs";

const { zcodeSessionMessagesResultSchema } = await tsImport(
  "../../packages/shared/src/index.ts",
  import.meta.url,
);

test("mobile layout history fixtures satisfy the CLI session/messages schema", () => {
  const result = zcodeSessionMessagesResultSchema.parse({ messages: createMobileMessages() });

  assert.equal(result.messages.length, 71);
  assert.deepEqual(
    new Set(result.messages.map((message) => message.info.role)),
    new Set(["user", "assistant"]),
  );
  assert.equal(result.messages[1]?.parts[0]?.text, longText);
  for (const message of result.messages) {
    for (const part of message.parts) {
      assert.equal(part.messageId, message.info.messageId);
      assert.equal(part.sessionId, message.info.sessionId);
    }
  }
});
