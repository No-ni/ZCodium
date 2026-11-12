import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, jsonSchema, stepCountIs, streamText, tool } from "ai";
import type { ModelNetworkStatusEvent, ModelStreamEvent } from "@zcode/contracts";
import type {
  AiSdkModelRuntime,
  AiSdkStreamTextOptions,
  AiSdkStreamTextResult,
  ResolvedAiSdkModel,
} from "../../src/model/runner-runtime.js";
import { resolveAiSdkModelRetryOptions } from "../../src/model/retry-policy.js";
import { runStreamText } from "../../src/model/runner-stream.js";

export type PartialUsageProtocol =
  | "anthropic"
  | "google"
  | "openai-chat"
  | "openai-responses"
  | "openai-compatible";
export const PARTIAL_USAGE_INPUT = 4800;
const CONSUMED_TEXT = "sdk-consumed-usage-prefix";
const textEncoder = new TextEncoder();
const encodeFrame = (frame: unknown) => textEncoder.encode(`data: ${JSON.stringify(frame)}\n\n`);

export function anthropicUsageFrames(
  options: {
    cache?: number;
    complete?: boolean;
    toolCall?: boolean;
    updates?: readonly Record<string, unknown>[];
  } = {},
) {
  const cache =
    options.cache === undefined
      ? {}
      : {
          cache_read_input_tokens: options.cache,
          cache_creation_input_tokens: options.cache === 0 ? 0 : 11,
        };
  const block = options.toolCall
    ? { type: "tool_use", id: "partial-tool", name: "Again", input: {} }
    : { type: "text", text: "" };
  const frames: unknown[] = [
    {
      type: "message_start",
      message: {
        id: "partial-message",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: PARTIAL_USAGE_INPUT, output_tokens: 0, ...cache },
      },
    },
    { type: "content_block_start", index: 0, content_block: block },
    {
      type: "content_block_delta",
      index: 0,
      delta: options.toolCall
        ? { type: "input_json_delta", partial_json: "{}" }
        : { type: "text_delta", text: CONSUMED_TEXT },
    },
  ];
  for (const usage of options.updates ?? [])
    frames.push({
      type: "message_delta",
      delta: { stop_reason: null, stop_sequence: null },
      usage,
    });
  if (options.complete)
    frames.push(
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: options.toolCall ? "tool_use" : "end_turn", stop_sequence: null },
        usage: { output_tokens: 23 },
      },
      { type: "message_stop" },
    );
  return frames;
}

function protocolFrames(protocol: PartialUsageProtocol, reportUsage: boolean): unknown[] {
  if (protocol === "anthropic") return anthropicUsageFrames({ cache: 0 });
  if (protocol === "google")
    return [
      {
        candidates: [{ content: { role: "model", parts: [{ text: CONSUMED_TEXT }] } }],
        ...(reportUsage
          ? {
              usageMetadata: {
                promptTokenCount: PARTIAL_USAGE_INPUT,
                candidatesTokenCount: 0,
                cachedContentTokenCount: 0,
              },
            }
          : {}),
      },
    ];
  if (protocol === "openai-responses") {
    const item = {
      id: "partial-item",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "", annotations: [] }],
    };
    return [
      {
        type: "response.created",
        response: {
          id: "partial-response",
          created_at: 1,
          model: "gpt-4.1",
          object: "response",
          status: "in_progress",
          output: [],
          ...(reportUsage
            ? {
                usage: {
                  input_tokens: PARTIAL_USAGE_INPUT,
                  output_tokens: 0,
                  input_tokens_details: { cached_tokens: 0 },
                },
              }
            : {}),
        },
      },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_text.delta", item_id: item.id, delta: CONSUMED_TEXT },
    ];
  }
  return [
    {
      id: "partial-chat",
      created: 1,
      model: "gpt-4.1",
      object: "chat.completion.chunk",
      choices: [
        { index: 0, delta: { role: "assistant", content: CONSUMED_TEXT }, finish_reason: null },
      ],
      ...(reportUsage
        ? {
            usage: {
              prompt_tokens: PARTIAL_USAGE_INPUT,
              completion_tokens: 0,
              prompt_tokens_details: { cached_tokens: 0 },
            },
          }
        : {}),
    },
  ];
}

/** 注入的内存 SSE 经过真实 SDK；只在已消费的 text/raw 边界取消，不用服务端 enqueue 猜费用。 */
export function createPartialUsageWireFixture(
  options: {
    protocol?: PartialUsageProtocol;
    frames?: readonly unknown[];
    mode?: "abort" | "disconnect" | "complete";
    abortAfterUsageDeltas?: number;
    completedFirstStep?: { cache?: number };
    reportUsage?: boolean;
  } = {},
) {
  const protocol = options.protocol ?? "anthropic";
  const mode = options.mode ?? "abort";
  const abortController = new AbortController();
  const statuses: ModelNetworkStatusEvent[] = [];
  const events: ModelStreamEvent[] = [];
  const sdkChunkTypes: string[] = [];
  let wireController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let requests = 0;
  let consumedUsageDeltas = 0;
  const interrupt = () => {
    if (mode === "disconnect")
      wireController?.error(new TypeError("synthetic stream disconnected after SDK consumption"));
    else abortController.abort();
  };
  const transport: typeof globalThis.fetch = async (_input, init) => {
    requests += 1;
    const firstComplete = options.completedFirstStep !== undefined && requests === 1;
    const complete = firstComplete || mode === "complete";
    const frames = firstComplete
      ? anthropicUsageFrames({ ...options.completedFirstStep, toolCall: true, complete: true })
      : (options.frames ?? protocolFrames(protocol, options.reportUsage !== false));
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of frames) controller.enqueue(encodeFrame(frame));
          if (complete) controller.close();
          else {
            wireController = controller;
            init?.signal?.addEventListener(
              "abort",
              () => controller.error(new DOMException("synthetic request cancelled", "AbortError")),
              { once: true },
            );
          }
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  const provider = {
    apiKey: "fixture-only",
    baseURL: "https://model.example.test/v1",
    fetch: transport,
  };
  const model =
    protocol === "anthropic"
      ? createAnthropic(provider)("claude-sonnet-4-5")
      : protocol === "google"
        ? createGoogleGenerativeAI(provider)("gemini-2.5-flash")
        : protocol === "openai-compatible"
          ? createOpenAICompatible({ ...provider, name: "fixture" }).chatModel("fixture")
          : protocol === "openai-chat"
            ? createOpenAI(provider).chat("gpt-4.1")
            : createOpenAI(provider).responses("gpt-4.1");
  const resolved = {
    providerId: "partial-fixture-provider",
    modelId: "partial-fixture-model",
    properties: {},
    model,
    providerKind:
      protocol.startsWith("openai-") && protocol !== "openai-compatible" ? "openai" : protocol,
  } as ResolvedAiSdkModel;
  const runtime: AiSdkModelRuntime = {
    generateText,
    streamText(input) {
      const streamOptions: AiSdkStreamTextOptions = {
        ...input,
        ...(options.completedFirstStep
          ? {
              tools: {
                Again: tool({
                  inputSchema: jsonSchema<Record<string, never>>({
                    type: "object",
                    properties: {},
                    additionalProperties: false,
                  }),
                  execute: async () => "continue",
                }),
              },
              stopWhen: stepCountIs(2),
            }
          : {}),
      };
      const result = streamText(streamOptions);
      // 夹具主动取消时，SDK 的 response 支路也会拒绝；只观察该支路，真实 stream 错误仍由 runner 传播。
      const response = Promise.resolve(result.response);
      void response.catch(() => undefined);
      return {
        response,
        fullStream: (async function* () {
          for await (const chunk of result.fullStream) {
            sdkChunkTypes.push(chunk.type);
            const delta =
              chunk.type === "raw" &&
              (chunk.rawValue as { type?: string })?.type === "message_delta";
            yield chunk;
            if (delta && ++consumedUsageDeltas === options.abortAfterUsageDeltas) interrupt();
          }
        })(),
      } as unknown as AiSdkStreamTextResult;
    },
  };
  return {
    statuses,
    events,
    sdkChunkTypes,
    get requests() {
      return requests;
    },
    get consumedUsageDeltas() {
      return consumedUsageDeltas;
    },
    async run() {
      for await (const event of runStreamText({
        env: {},
        resolved,
        resolveModel: () => resolved,
        runtime,
        request: {
          messages: [{ role: "user", content: "partial usage fixture" }],
          abortSignal: abortController.signal,
          ...(options.abortAfterUsageDeltas ? { preserveProviderStreamBoundaries: true } : {}),
        },
        retry: resolveAiSdkModelRetryOptions({ maxAttempts: 1 }, {}),
        streamIdleTimeoutMs: 1000,
        statusSink: {
          publish(event) {
            statuses.push(event);
          },
        },
      })) {
        events.push(event);
        if (
          mode !== "complete" &&
          !options.abortAfterUsageDeltas &&
          event.type === "text_delta" &&
          event.text === CONSUMED_TEXT
        )
          interrupt();
      }
      return events.findLast((event) => event.type === "finish")?.usage;
    },
  };
}
