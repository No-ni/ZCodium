import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, jsonSchema, stepCountIs, streamText, tool, type ToolSet } from "ai";
import type { ModelNetworkStatusEvent, ModelStreamEvent } from "@zcode/contracts";
import type {
  AiSdkModelRuntime,
  AiSdkStreamTextResult,
  ResolvedAiSdkModel,
} from "../../src/model/runner-runtime.js";
import { resolveAiSdkModelRetryOptions } from "../../src/model/retry-policy.js";
import { runGenerateText } from "../../src/model/runner-generate.js";
import { runStreamText } from "../../src/model/runner-stream.js";

export type CacheProtocol =
  | "anthropic"
  | "google"
  | "openai-chat"
  | "openai-responses"
  | "openai-compatible";
export type CacheValue = number | null | undefined;

function sse(parts: readonly unknown[]): Response {
  return new Response(parts.map((part) => "data: " + JSON.stringify(part) + "\n\n").join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function anthropicResponse(cache: CacheValue, streaming: boolean, toolCall: boolean): Response {
  const cacheFields =
    cache === undefined
      ? {}
      : {
          cache_read_input_tokens: cache,
          cache_creation_input_tokens: cache === null || cache === 0 ? cache : 11,
        };
  const content = toolCall
    ? { type: "tool_use", id: "tool-fixture", name: "Again", input: {} }
    : { type: "text", text: "ok" };
  const body = {
    id: "message-fixture",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5",
    content: [content],
    stop_reason: toolCall ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 2, ...cacheFields },
  };
  if (!streaming) return Response.json(body);
  return sse([
    {
      type: "message_start",
      message: {
        ...body,
        content: [],
        stop_reason: null,
        usage: { ...body.usage, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: toolCall ? content : { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: toolCall
        ? { type: "input_json_delta", partial_json: "{}" }
        : { type: "text_delta", text: "ok" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: body.stop_reason, stop_sequence: null },
      usage: { output_tokens: 2 },
    },
    { type: "message_stop" },
  ]);
}

function googleResponse(cache: CacheValue, streaming: boolean): Response {
  const body = {
    candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
    usageMetadata: {
      promptTokenCount: 100,
      candidatesTokenCount: 2,
      totalTokenCount: 102,
      ...(cache === undefined ? {} : { cachedContentTokenCount: cache }),
    },
  };
  return streaming ? sse([body]) : Response.json(body);
}

function openaiResponse(cache: CacheValue, streaming: boolean, responses: boolean): Response {
  const cached = cache === undefined ? {} : { cached_tokens: cache };
  if (responses) {
    const item = {
      type: "message",
      role: "assistant",
      id: "item-fixture",
      content: [{ type: "output_text", text: "ok", annotations: [] }],
    };
    const body = {
      id: "response-fixture",
      created_at: 1,
      model: "gpt-4.1",
      object: "response",
      status: "completed",
      output: [item],
      usage: { input_tokens: 100, output_tokens: 2, input_tokens_details: cached },
    };
    return streaming
      ? sse([
          { type: "response.created", response: body },
          { type: "response.output_item.added", output_index: 0, item },
          { type: "response.output_text.delta", item_id: item.id, delta: "ok" },
          { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response: body },
        ])
      : Response.json(body);
  }
  const common = { id: "chat-fixture", created: 1, model: "gpt-4.1" };
  const usage = {
    prompt_tokens: 100,
    completion_tokens: 2,
    total_tokens: 102,
    prompt_tokens_details: cached,
  };
  return streaming
    ? sse([
        {
          ...common,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
        },
        {
          ...common,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage,
        },
      ])
    : Response.json({
        ...common,
        object: "chat.completion",
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage,
      });
}

export function createCacheUsageWireFixture(
  protocol: CacheProtocol,
  mode: "stream" | "generate",
  cache: CacheValue,
  options: {
    secondStep?: { cache: CacheValue };
    failAfterStep?: boolean;
    failureKind?: "throw" | "chunk";
  } = {},
) {
  const requests: Array<{ streaming: boolean }> = [];
  const statuses: ModelNetworkStatusEvent[] = [];
  const transport: typeof globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { stream?: boolean };
    const streaming = mode === "stream";
    requests.push({ streaming: request.stream ?? streaming });
    const stepCache = requests.length > 1 ? options.secondStep!.cache : cache;
    if (protocol === "anthropic")
      return anthropicResponse(
        stepCache,
        streaming,
        options.secondStep !== undefined && requests.length === 1,
      );
    if (protocol === "google") return googleResponse(stepCache, streaming);
    return openaiResponse(stepCache, streaming, protocol === "openai-responses");
  };
  const providerOptions = {
    apiKey: "fixture-only",
    baseURL: "https://model.example.test/v1",
    fetch: transport,
  };
  const model =
    protocol === "anthropic"
      ? createAnthropic(providerOptions)("claude-sonnet-4-5")
      : protocol === "google"
        ? createGoogleGenerativeAI(providerOptions)("gemini-2.5-flash")
        : protocol === "openai-compatible"
          ? createOpenAICompatible({ ...providerOptions, name: "fixture" }).chatModel("fixture")
          : protocol === "openai-chat"
            ? createOpenAI(providerOptions).chat("gpt-4.1")
            : createOpenAI(providerOptions).responses("gpt-4.1");
  const resolved = {
    providerId: "fixture-provider",
    modelId: "fixture-model",
    providerKind:
      protocol.startsWith("openai-") && protocol !== "openai-compatible" ? "openai" : protocol,
    properties: {},
    model,
  } as ResolvedAiSdkModel;
  const tools: ToolSet | undefined = options.secondStep
    ? {
        Again: tool({
          inputSchema: jsonSchema<Record<string, never>>({
            type: "object",
            properties: {},
            additionalProperties: false,
          }),
          execute: async () => "next step",
        }),
      }
    : undefined;
  const runtime: AiSdkModelRuntime = {
    generateText: (input) =>
      generateText({ ...input, ...(tools ? { tools, stopWhen: stepCountIs(2) } : {}) }),
    streamText: (input) => {
      const result = streamText({
        ...input,
        ...(tools ? { tools, stopWhen: stepCountIs(2) } : {}),
      });
      if (!options.failAfterStep) return result;
      const upstream = result.fullStream;
      return {
        fullStream: (async function* () {
          for await (const chunk of upstream) {
            yield chunk;
            if (chunk.type === "finish-step") {
              const error = new Error("fixture stream failed after reported step");
              if (options.failureKind === "chunk") {
                yield { type: "error", error };
                return;
              }
              throw error;
            }
          }
        })(),
        response: Promise.resolve({ headers: {} }),
      } as unknown as AiSdkStreamTextResult;
    },
  };
  const input: Parameters<typeof runStreamText>[0] = {
    env: {},
    resolved,
    resolveModel: () => resolved,
    request: { messages: [{ role: "user", content: "fixture" }] },
    retry: resolveAiSdkModelRetryOptions({ maxAttempts: 1 }, {}),
    runtime,
    streamIdleTimeoutMs: 500,
    statusSink: {
      publish: (event) => {
        statuses.push(event);
      },
    },
  };
  return {
    input,
    requests,
    statuses,
    async run() {
      if (mode === "generate") return (await runGenerateText(input)).usage;
      const events: ModelStreamEvent[] = [];
      for await (const event of runStreamText(input)) events.push(event);
      return events.findLast((event) => event.type === "finish")?.usage;
    },
  };
}
