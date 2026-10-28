import assert from "node:assert/strict";
import test from "node:test";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { toAiSdkMessages } from "../src/model/transform.js";
import { toAiSdkTools } from "../src/model/tool-transform.js";
import { resolveToolSearchCapability, toolSearchHeaders } from "../src/model/tool-search.js";
import { createModel } from "../src/model/model.js";

const reference = { type: "tool_reference", toolName: "FixtureTool" };
const messages = [
  {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "search", name: "ToolSearch", input: { query: "select:FixtureTool" } }],
  },
  {
    role: "tool",
    toolCallId: "search",
    toolName: "ToolSearch",
    content: [{ type: "text", text: "before" }, reference, { type: "text", text: "after" }],
  },
] as any;

test("native capability is based on actual supported wire, never an official account or plan", () => {
  assert.deepEqual(resolveToolSearchCapability("anthropic-messages"), {
    protocolSupported: true,
    defaultEnabled: false,
  });
  for (const api of [
    "openai-chat-completions",
    "openai-responses",
    "google-generative-ai",
    "unknown",
  ]) {
    assert.deepEqual(resolveToolSearchCapability(api), {
      protocolSupported: false,
      defaultEnabled: false,
    });
  }
  assert.deepEqual(
    toolSearchHeaders({ "Anthropic-Beta": "existing,existing", other: "fixture" }, true),
    { "Anthropic-Beta": "existing,advanced-tool-use-2025-11-20", other: "fixture" },
  );
  assert.equal(toolSearchHeaders(undefined, false), undefined);
});

test("real Anthropic SDK mock wire retains tool_reference/defer_loading/beta even when media are stripped", async () => {
  for (const stripMedia of [false, true]) {
    let body: any;
    let headers: Headers | undefined;
    const provider = createAnthropic({
      apiKey: "mock-only-key",
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        headers = new Headers(init?.headers);
        return Response.json({
          id: "fixture",
          type: "message",
          role: "assistant",
          model: "fixture",
          content: [{ type: "text", text: "done" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      },
    });
    await generateText({
      model: provider("fixture-model"),
      maxRetries: 0,
      headers: toolSearchHeaders({ "anthropic-beta": "fixture-beta" }, true),
      tools: toAiSdkTools(
        [{ name: "FixtureTool", inputSchema: { type: "object" }, deferLoading: true }] as any,
        { providerKind: "anthropic", toolSearchEnabled: true } as any,
      ),
      messages: toAiSdkMessages(messages, {
        providerKind: "anthropic",
        toolSearchEnabled: true,
        stripMedia,
      } as any),
    });
    assert.equal(body.tools[0].defer_loading, true);
    assert.deepEqual(body.messages[1].content[0].content, [
      { type: "text", text: "before" },
      { type: "tool_reference", tool_name: "FixtureTool" },
      { type: "text", text: "after" },
    ]);
    assert.ok(headers?.get("anthropic-beta")?.includes("advanced-tool-use-2025-11-20"));
    assert.ok(headers?.get("anthropic-beta")?.includes("fixture-beta"));
  }
});

test("unsupported/non-native requests never serialize native references or deferLoading", () => {
  const transformed = toAiSdkMessages(messages, { providerKind: "google" });
  assert.ok(!JSON.stringify(transformed).includes('"type":"custom"'));
  const tools = toAiSdkTools(
    [{ name: "FixtureTool", inputSchema: { type: "object" }, deferLoading: true }] as any,
    { providerKind: "anthropic" },
  );
  assert.ok(tools?.FixtureTool, "fixture tool must remain exposed without native deferral");
  assert.equal((tools.FixtureTool as any).providerOptions?.anthropic?.deferLoading, undefined);
});

test("model bind and prepared request carry frozen wire capability and request-local native flag", async () => {
  const seen: any[] = [];
  const capability = { toolSearch: { protocolSupported: true, defaultEnabled: false } };
  const model = createModel({
    providerId: "fixture" as any,
    modelId: "fixture" as any,
    properties: { supportsToolCall: true, supportsJsonSchemaOutput: false, inputFormat: {} } as any,
    optionSpecs: { reasoningLevel: { values: ["off"] }, maxOutputTokens: { max: 1024 } } as any,
    options: { maxOutputTokens: 512, reasoningLevel: "off" },
    requestCapabilities: capability,
    executor: {
      generateText: async (request) => {
        seen.push(request);
        return { text: "done", finishReason: "stop", usage: {} };
      },
      streamText: async function* () {},
    },
  } as any);
  const bound = model.bind({ maxOutputTokens: 256 });
  assert.deepEqual((bound as any).requestCapabilities, capability);
  await bound.generateText({
    messages: [{ role: "user", content: "fixture" }],
    tools: [{ name: "ToolSearch", inputSchema: { type: "object" } }],
    toolSearchEnabled: true,
  } as any);
  await bound.generateText({ messages: [{ role: "user", content: "auxiliary" }], tools: [] });
  await bound.generateText({
    messages: [{ role: "user", content: "auxiliary" }],
    tools: [],
    toolSearchEnabled: true,
  });
  assert.equal(seen[0].toolSearchEnabled, true);
  assert.ok(seen[1].toolSearchEnabled !== true);
  assert.equal(seen[2].toolSearchEnabled, false);

  const unsupported = createModel({
    providerId: "fixture" as any,
    modelId: "fixture" as any,
    properties: model.properties,
    optionSpecs: model.optionSpecs,
    options: model.options,
    requestCapabilities: { toolSearch: { protocolSupported: false, defaultEnabled: false } },
    executor: {
      generateText: async () => assert.fail("unsupported native must fail before executor"),
      streamText: async function* () {},
    },
  });
  await assert.rejects(
    unsupported.generateText({
      messages: [],
      tools: [{ name: "ToolSearch", inputSchema: {} }],
      toolSearchEnabled: true,
    }),
    /supported.*wire/i,
  );
});
