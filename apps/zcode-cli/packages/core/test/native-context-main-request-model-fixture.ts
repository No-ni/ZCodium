import assert from "node:assert/strict";
import {
  createModelId,
  createModelProviderId,
  getCurrentModelInvocationContext,
  ModelTransportKind,
  type Model,
  type ModelRequest,
  type ModelResult,
  type ModelStreamEvent,
} from "@zcode/contracts";
import type { NativeContextObservation } from "@zcode/shared/native-context-compression";

export const ANSWER = "Fixture main answer based on the compressed context.";
export const USAGE = { inputTokens: 320, outputTokens: 9, cacheReadTokens: 0 };

export function createMainRequestModelFixture(options: {
  images?: boolean;
  order: string[];
  rows: () => Promise<NativeContextObservation[]>;
}) {
  const calls: { requestId: string; request: ModelRequest }[] = [];
  const prepared: NativeContextObservation[] = [];
  const providerId = createModelProviderId("main-fixture-provider");
  const modelId = createModelId(options.images ? "main-fixture-vision" : "main-fixture-text");
  function physicalCall(request: ModelRequest, transport: ModelTransportKind) {
    const context = getCurrentModelInvocationContext();
    assert.ok(
      context?.statusSink && context.traceContext,
      "the actual request must install its runtime statusSink",
    );
    const sink = context.statusSink;
    const trace = context.traceContext;
    const call = { request, requestId: "main-physical-" + (calls.length + 1) };
    calls.push(call);
    const startedAt = Date.now();
    const identity = {
      requestId: call.requestId,
      providerId,
      modelId,
      transport,
      attempt: 1,
      maxAttempts: 1,
      traceId: trace.traceId,
      spanId: trace.spanId,
    };
    return {
      async start() {
        await sink.publish({
          ...identity,
          type: "model_request_started",
          timestamp: new Date(startedAt).toISOString(),
        });
        prepared.push(...(await options.rows()));
      },
      async complete(): Promise<ModelResult> {
        await sink.publish({
          ...identity,
          type: "model_request_completed",
          timestamp: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
          finishReason: "stop",
          usage: USAGE,
        });
        options.order.push("provider-completed");
        return { text: ANSWER, finishReason: "stop", usage: USAGE, toolCalls: [], reasoning: [] };
      },
    };
  }
  const model: Model = {
    providerId,
    modelId,
    options: { reasoningLevel: "medium" },
    properties: {
      requiresMfjsToolSchema: false,
      contextWindow: 32768,
      inputFormat: {
        supportsText: true,
        supportsImage: options.images === true,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: false,
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
    },
    optionSpecs: {
      reasoningLevel: { values: ["medium"], map: "({})" },
      maxOutputTokens: { max: 1024, map: "({})" },
    },
    bind(patch) {
      return { ...model, options: { ...model.options, ...patch } };
    },
    async generateText(request) {
      const call = physicalCall(request, ModelTransportKind.Http);
      await call.start();
      return call.complete();
    },
    streamText(request) {
      // 调用上下文在 stream 创建时冻结，异步迭代不从外层 AsyncLocalStorage 猜身份。
      const call = physicalCall(request, ModelTransportKind.Sse);
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        await call.start();
        yield { type: "start" };
        yield { type: "text_start", id: "main-text" };
        yield { type: "text_delta", id: "main-text", text: ANSWER };
        yield { type: "text_end", id: "main-text" };
        const result = await call.complete();
        yield { type: "finish", finishReason: result.finishReason, usage: result.usage };
      })();
    },
  };
  return { model, providerId, modelId, calls, prepared };
}
