import assert from "node:assert/strict";
import test from "node:test";
import { generateText, streamText } from "ai";
import { AiSdkModelExecution } from "../src/model/model-execution.js";
import { toAiSdkMessages } from "../src/model/transform.js";
import { toAiSdkTools } from "../src/model/tool-transform.js";
import { normalizeToolCalls, toModelStreamEvent } from "../src/model/runner-normalization.js";
import {
  createRuntimeAssistantEntry,
  createMessageHistory,
} from "../../core/src/agent/message-history.js";
import { hydrateMessageHistoryFromSession } from "../../core/src/agent/session-history-hydrator.js";
import { persistPendingToolPart } from "../../core/src/runtime/methods/tool-part-persistence.js";
import { encodeJson, decodeJson } from "../src/storage/session-store/json.js";

const response = (parts: unknown[] = [{ text: "pong" }]) => ({
  candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
});
const specs = {
  reasoningLevel: {
    map: 'reasoningLevel == "disabled" ? {} : {"generationConfig":{"thinkingConfig":{"thinkingLevel":"high","includeThoughts":true}}}',
  },
  maxOutputTokens: { map: '{"generationConfig":{"maxOutputTokens":maxOutputTokens}}' },
};
function fixture(
  baseUrl = "https://gateway.example/google/v1beta",
  streaming = false,
  parts?: unknown[],
) {
  const requests: { url: string; headers: Headers; body: Record<string, any> }[] = [];
  const execution = new AiSdkModelExecution(
    {},
    {
      transport: async (input, init) => {
        requests.push({
          url: String(input),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        });
        return streaming
          ? new Response(
              `data: ${JSON.stringify(response(parts ?? [{ thought: true, text: "thinking" }, { text: "pong" }]))}\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            )
          : Response.json(response(parts));
      },
    },
  );
  const bound = execution.bindModel({
    providerId: "custom-google",
    modelId: "gemini-4-argon",
    providerConfig: {
      access: { type: "api-key", apiKey: "mock-only-key" },
      api: { type: "google-generative-ai", baseUrl },
    },
    supportsJsonSchemaOutput: true,
    optionSpecs: specs,
  });
  return { requests, bound };
}

test("Gemini binding uses configured native URL, auth, system and model roles", async () => {
  for (const baseUrl of [
    "https://gateway.example/google/v1beta",
    "https://opencode.ai/inference/go/google/v1beta",
    "https://opencode.ai/inference/google/v1beta",
  ]) {
    const { requests, bound } = fixture(baseUrl);
    const result = await generateText({
      model: bound.resolveRequest({
        options: { reasoningLevel: "disabled", maxOutputTokens: 1024 },
      }).model,
      allowSystemInMessages: true,
      messages: toAiSdkMessages(
        [
          { role: "system", content: "system rule" },
          { role: "user", content: "ping" },
          { role: "assistant", content: "previous" },
          { role: "user", content: "again" },
        ],
        { providerKind: "google" },
      ),
    });
    assert.equal(result.text, "pong");
    assert.equal(bound.resolved.providerKind, "google");
    const request = requests[0]!;
    assert.equal(request.url, `${baseUrl}/models/gemini-4-argon:generateContent`);
    assert.equal(request.headers.get("x-goog-api-key"), "mock-only-key");
    assert.equal(request.headers.get("authorization"), null);
    assert.equal(request.headers.get("x-api-key"), null);
    assert.equal(request.body.messages, undefined);
    assert.equal(request.body.systemInstruction.parts[0].text, "system rule");
    assert.equal(request.body.contents[1].role, "model");
    assert.equal(request.body.generationConfig.maxOutputTokens, 1024);
    assert.equal(request.body.generationConfig.thinkingConfig, undefined);
  }
});

test("Gemini stream preserves text and thoughts and applies final thinking/output options", async () => {
  const { requests, bound } = fixture(undefined, true);
  const result = streamText({
    model: bound.resolveRequest({ options: { reasoningLevel: "enabled", maxOutputTokens: 32768 } })
      .model,
    prompt: "ping",
  });
  const chunks = [];
  for await (const chunk of result.fullStream) chunks.push(chunk);
  assert.equal(await result.text, "pong");
  assert.equal(await result.reasoningText, "thinking");
  assert.ok(chunks.some((chunk) => chunk.type === "text-delta"));
  assert.match(requests[0]!.url, /:streamGenerateContent\?alt=sse$/);
  assert.deepEqual(requests[0]!.body.generationConfig.thinkingConfig, {
    thinkingLevel: "high",
    includeThoughts: true,
  });
  assert.equal(requests[0]!.body.generationConfig.maxOutputTokens, 32768);
  assert.equal(requests[0]!.body.maxOutputTokens, undefined);
});

test("Gemini encodes function declarations and tool-result continuation through ZCode transforms", async () => {
  const { requests, bound } = fixture();
  const messages = toAiSdkMessages(
    [
      { role: "user", content: "look up" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "lookup",
            input: { query: "x" },
            providerOptions: { google: { thoughtSignature: "mock-signature" } },
          },
        ],
      },
      { role: "tool", content: "found", toolCallId: "call-1", toolName: "lookup" },
    ],
    { providerKind: "google" },
  );
  const tools = toAiSdkTools(
    [
      {
        name: "lookup",
        description: "Look up",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ],
    { providerKind: "google" },
  );
  await generateText({ model: bound.resolved.model, messages, tools });
  const body = requests[0]!.body;
  assert.equal(body.tools[0].functionDeclarations[0].name, "lookup");
  assert.equal(body.contents[1].parts[0].functionCall.name, "lookup");
  assert.equal(body.contents[2].parts[0].functionResponse.name, "lookup");
  assert.equal(body.contents[2].parts[0].functionResponse.response.content, "found");
});

test("Gemini converts image data URLs to native inlineData", async () => {
  const { requests, bound } = fixture();
  const messages = toAiSdkMessages(
    [
      {
        role: "user",
        content: [
          { type: "text", text: "image" },
          { type: "image", dataUrl: "data:image/png;base64,aGVsbG8=", mediaType: "image/png" },
        ],
      },
    ],
    { providerKind: "google" },
  );
  await generateText({ model: bound.resolved.model, messages });
  assert.deepEqual(requests[0]!.body.contents[0].parts[1].inlineData, {
    mimeType: "image/png",
    data: "aGVsbG8=",
  });
});

test("Gemini real tool signatures survive native response, stream, durable JSON and cold hydration", async () => {
  const { bound, requests } = fixture();
  const signature = "mock-real-provider-signature";
  const parts = [
    { functionCall: { name: "lookup", args: { query: "x" } }, thoughtSignature: signature },
  ];
  const tools = toAiSdkTools(
    [
      {
        name: "lookup",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ],
    { providerKind: "google" },
  );
  const native = fixture(undefined, false, parts);
  const sdkResult = await generateText({
    model: native.bound.resolved.model,
    prompt: "look up",
    tools,
  });
  const calls = normalizeToolCalls(sdkResult)!;
  assert.equal((calls[0]!.providerOptions as any).google.thoughtSignature, signature);
  const streamed = fixture(undefined, true, parts);
  const sdkStream = streamText({ model: streamed.bound.resolved.model, prompt: "look up", tools });
  let stream: ReturnType<typeof toModelStreamEvent>;
  for await (const chunk of sdkStream.fullStream) {
    if (chunk.type === "tool-call") stream = toModelStreamEvent(chunk);
  }
  assert.equal((stream! as any).toolCall.providerOptions.google.thoughtSignature, signature);
  const live = createRuntimeAssistantEntry("", calls);
  assert.equal(
    (live.message.toolCalls![0]!.providerOptions as any).google.thoughtSignature,
    signature,
  );
  let persisted: any;
  await persistPendingToolPart(
    {
      sessionId: "session-test",
      persistPart: async (part: unknown) => {
        persisted = decodeJson(encodeJson(part));
      },
    } as any,
    {
      assistantMessageId: "message-test" as any,
      partID: "part-test" as any,
      declarationIndex: 0,
      toolCall: { id: "call-signed", name: "lookup", input: { query: "x" } } as any,
      providerOptions: calls[0]!.providerOptions,
      input: { query: "x" },
      traceContext: {} as any,
      model: {} as any,
    },
  );
  persisted.state = {
    status: "completed",
    input: { query: "x" },
    output: "found",
    title: "lookup",
    time: { start: 1, end: 2 },
  };
  const history = createMessageHistory();
  await hydrateMessageHistoryFromSession({
    history,
    messages: [
      {
        info: {
          id: "message-test",
          sessionID: "session-test",
          role: "assistant",
          time: { created: 1 },
          modelId: "gemini-4-argon",
          providerId: "custom-google",
        },
        parts: [persisted],
      },
    ] as any,
  });
  const restored = history
    .toRuntimeEntries()
    .flatMap((entry) => (entry.kind === "attachment" ? [] : [entry.message]));
  assert.equal(
    (restored[0]!.toolCalls![0]!.providerOptions as any).google.thoughtSignature,
    signature,
  );
  await generateText({
    model: bound.resolved.model,
    messages: toAiSdkMessages([{ role: "user", content: "look up" }, ...restored], {
      providerKind: "google",
      modelId: "gemini-4-argon",
    }),
  });
  assert.equal(requests[0]!.body.contents[1].parts[0].thoughtSignature, signature);
  assert.ok(!JSON.stringify(requests[0]!.body).includes("skip_thought_signature_validator"));
});

test("Gemini tool metadata belongs to canonical history, not writable request snapshots", () => {
  const source = () => ({
    role: "assistant" as const,
    content: "",
    toolCalls: [
      {
        id: "call-1",
        name: "lookup",
        input: {},
        providerOptions: { google: { thoughtSignature: "original-signature" } },
      },
    ],
  });
  for (const admission of ["init", "replaceMessages", "addEntries", "addAssistant"] as const) {
    const history = createMessageHistory();
    const incoming = source();
    if (admission === "addAssistant") history.addAssistant("", incoming.toolCalls);
    else if (admission === "addEntries") history.addEntries([{ message: incoming }]);
    else history[admission]([incoming]);
    incoming.toolCalls[0]!.providerOptions.google.thoughtSignature = "changed-incoming";
    const snapshot = history.toRuntimeEntries()[0]!;
    assert.ok(snapshot.kind !== "attachment");
    assert.equal(
      (snapshot.message.toolCalls![0]!.providerOptions as any).google.thoughtSignature,
      "original-signature",
      admission,
    );
    (snapshot.message.toolCalls![0]!.providerOptions as any).google.thoughtSignature =
      "changed-snapshot";
    const canonical = history.borrowReadOnlyRuntimeEntries()[0]!;
    assert.ok(canonical.kind !== "attachment");
    assert.equal(
      (canonical.message.toolCalls![0]!.providerOptions as any).google.thoughtSignature,
      "original-signature",
      admission,
    );
  }
});

test("Gemini old unsigned history stays readable but fails before SDK sentinel injection", () => {
  const legacy = [
    {
      role: "assistant" as const,
      content: "",
      toolCalls: [{ id: "legacy", name: "lookup", input: {} }],
    },
  ];
  assert.throws(
    () => toAiSdkMessages(legacy, { providerKind: "google", modelId: "gemini-4-argon" }),
    /missing its thought signature/,
  );
  // @ai-sdk/google 3.0.135 的 getGoogleModelCapabilities 明确把这些归为旧代，不能受 3+ 签名保护误伤。
  for (const modelId of [
    "gemini-2.5-pro",
    "gemini-pro",
    "gemini-pro-vision",
    "gemini-robotics-er-1.5",
    "models/gemini-robotics-er-1.5-preview",
  ]) {
    assert.doesNotThrow(() => toAiSdkMessages(legacy, { providerKind: "google", modelId }));
  }
});

test("Gemini provider-native WebSearch encodes Google search, not a function placeholder", async () => {
  const { requests, bound } = fixture();
  const contract = {
    name: "WebSearch",
    description: "Search",
    inputSchema: { type: "object" },
    providerNative: { logicalName: "WebSearch" as const, args: {} },
  };
  const tools = toAiSdkTools([contract], { providerKind: "google", supportsNativeWebSearch: true });
  await generateText({ model: bound.resolved.model, prompt: "search", tools });
  assert.deepEqual(requests[0]!.body.tools, [{ googleSearch: {} }]);
  assert.throws(
    () => toAiSdkTools([contract], { providerKind: "google", supportsNativeWebSearch: false }),
    /does not support/,
  );
  assert.throws(
    () =>
      toAiSdkTools(
        [
          {
            ...contract,
            providerNative: {
              ...contract.providerNative,
              args: { allowedDomains: ["example.test"] },
            },
          },
        ],
        { providerKind: "google", supportsNativeWebSearch: true },
      ),
    /does not support domain filters/,
  );
});
