import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { modelInputMessageJsonSchema } from "../src/model/index.js";

const validate = new Ajv({ strict: false }).compile(modelInputMessageJsonSchema);

describe("模型消息的实际 JSON schema 校验", () => {
  const blocks = [
    { type: "tool_reference", toolName: "Read" },
    { type: "text", text: "fixture" },
    { type: "reasoning", text: "fixture", blockIndex: 0 },
    { type: "image", mediaType: "image/png", dataUrl: "data:image/png;base64,AA==" },
    { type: "video", mediaType: "video/mp4", dataUrl: "data:video/mp4;base64,AA==" },
    { type: "file", mediaType: "text/plain", text: "fixture" },
    { type: "resource_link", uri: "fixture:resource" },
  ];

  it.each(blocks)("接受 $type 块", (block) => {
    // oneOf 的重复分支会拒绝合法工具引用；必须用验证器覆盖实际匹配语义。
    expect(validate({ role: "user", content: [block] }), JSON.stringify(validate.errors)).toBe(
      true,
    );
  });

  it("接受纯文本和包含工具引用的混合内容", () => {
    expect(validate({ role: "user", content: "fixture" })).toBe(true);
    expect(validate({ role: "user", content: blocks }), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each([
    { type: "tool_reference", toolName: "" },
    { type: "tool_reference" },
    { type: "tool_reference", toolName: "Read", unexpected: true },
    { type: "unknown", toolName: "Read" },
  ])("继续拒绝非法内容 $type", (block) => {
    expect(validate({ role: "user", content: [block] })).toBe(false);
  });
});
