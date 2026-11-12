import assert from "node:assert/strict";
import {
  createModelId,
  createModelProviderId,
  getCurrentModelInvocationContext,
  ModelTransportKind,
  type Model,
  type ModelRequest,
  type ModelResult,
  type ModelSelection,
} from "@zcode/contracts";

export const NCTX_BATCH_MAIN = {
  providerId: "nctx-batch-provider",
  modelId: "nctx-batch-main",
} satisfies ModelSelection;
export const NCTX_BATCH_MAINTENANCE = {
  providerId: "nctx-batch-provider",
  modelId: "nctx-batch-maintenance",
} satisfies ModelSelection;
export const NCTX_BATCH_MAIN_USAGE = { inputTokens: 320, outputTokens: 9, cacheReadTokens: 0 };
export const NCTX_BATCH_MAINTENANCE_USAGE = {
  inputTokens: 40,
  outputTokens: 8,
  cacheReadTokens: 0,
};
export const NCTX_BATCH_TOOL_NAMES = ["NctxBatchFirst", "NctxBatchSecond"] as const;
export const NCTX_BATCH_CALL_IDS = ["nctx-batch-first-call", "nctx-batch-second-call"] as const;
export const NCTX_BATCH_OLD_TEXT =
  "Synthetic historical observation: the old operation completed and its decision remains relevant. ".repeat(
    110,
  );
export const NCTX_BATCH_FINAL_TEXT = "Synthetic current answer after both complete tool results.";

export function batchDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = () => complete();
  });
  return { promise, resolve };
}

export interface NctxBatchPhysicalCall {
  model: ModelSelection;
  requestId: string;
  request: ModelRequest;
  querySource: string;
}

/** 只替代 Provider 传输；调用上下文、请求观察和费用记录仍由实际 Runtime 建立。 */
export function createNctxBatchModels(options: {
  finalEntered: ReturnType<typeof batchDeferred>;
  finalRelease: ReturnType<typeof batchDeferred>;
  maintenanceEntered: ReturnType<typeof batchDeferred>;
  maintenanceRelease: ReturnType<typeof batchDeferred>;
  onFinal: () => Promise<void>;
  onMaintenance: () => Promise<void>;
  order: string[];
}) {
  const calls: NctxBatchPhysicalCall[] = [];
  let mainRequests = 0;
  const makeModel = (selection: ModelSelection): Model => {
    const providerId = createModelProviderId(selection.providerId);
    const modelId = createModelId(selection.modelId);
    const maintenance = selection.modelId === NCTX_BATCH_MAINTENANCE.modelId;
    const model: Model = {
      providerId,
      modelId,
      options: { reasoningLevel: "medium" },
      properties: {
        requiresMfjsToolSchema: false,
        contextWindow: 65536,
        inputFormat: {
          supportsText: true,
          supportsImage: false,
          supportsVideo: false,
          supportsAudio: false,
          supportsPdf: false,
        },
        outputFormat: { supportsText: true },
        supportsToolCall: !maintenance,
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
        const context = getCurrentModelInvocationContext();
        assert.ok(context?.traceContext && context.statusSink);
        const call: NctxBatchPhysicalCall = {
          model: { ...selection },
          request,
          requestId: `nctx-batch-physical-${calls.length + 1}`,
          querySource: String(context.metadata?.querySource ?? "main"),
        };
        calls.push(call);
        const startedAt = Date.now();
        const identity = {
          requestId: call.requestId,
          providerId,
          modelId,
          transport: ModelTransportKind.Http,
          attempt: 1,
          maxAttempts: 1,
          traceId: context.traceContext.traceId,
          spanId: context.traceContext.spanId,
        };
        await context.statusSink.publish({
          ...identity,
          type: "model_request_started",
          timestamp: new Date(startedAt).toISOString(),
        });
        let result: ModelResult;
        if (maintenance) {
          assert.equal(call.querySource, "native_context_maintenance");
          await options.onMaintenance();
          options.order.push("maintenance-start");
          options.maintenanceEntered.resolve();
          await options.maintenanceRelease.promise;
          request.abortSignal?.throwIfAborted();
          const user = request.messages.findLast((message) => message.role === "user");
          assert.equal(typeof user?.content, "string");
          const offered = JSON.parse(user!.content as string) as {
            ranges: { startRef: string; endRef: string }[];
          };
          assert.ok(offered.ranges.length > 0);
          result = {
            text: JSON.stringify({
              ranges: offered.ranges.map((range) => ({
                startRef: range.startRef,
                endRef: range.endRef,
                summary:
                  "Synthetic summary: the old operation completed; preserve its decision and outstanding constraints.",
              })),
              outputs: [],
            }),
            finishReason: "stop",
            usage: NCTX_BATCH_MAINTENANCE_USAGE,
            reasoning: [],
            toolCalls: [],
          };
        } else {
          mainRequests++;
          assert.ok(mainRequests <= 3, "no implicit model retry or additional main request");
          if (mainRequests === 2) {
            assert.ok(
              NCTX_BATCH_TOOL_NAMES.every((name) =>
                request.tools?.some((tool) => tool.name === name),
              ),
            );
            options.order.push("main-tool-call");
            result = {
              text: "",
              finishReason: "tool-calls",
              usage: NCTX_BATCH_MAIN_USAGE,
              reasoning: [],
              toolCalls: NCTX_BATCH_TOOL_NAMES.map((name, index) => ({
                id: NCTX_BATCH_CALL_IDS[index]!,
                name,
                input: { slot: index === 0 ? "first" : "second" },
              })),
            };
          } else {
            if (mainRequests === 3) {
              await options.onFinal();
              options.order.push("main-final-pending");
              options.finalEntered.resolve();
              await options.finalRelease.promise;
              request.abortSignal?.throwIfAborted();
            }
            result = {
              text: mainRequests === 1 ? NCTX_BATCH_OLD_TEXT : NCTX_BATCH_FINAL_TEXT,
              finishReason: "stop",
              usage: NCTX_BATCH_MAIN_USAGE,
              reasoning: [],
              toolCalls: [],
            };
          }
        }
        await context.statusSink.publish({
          ...identity,
          type: "model_request_completed",
          timestamp: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
          finishReason: result.finishReason,
          usage: result.usage,
        });
        return result;
      },
      streamText() {
        throw new Error("NCTX_BATCH_NONSTREAMING_MODEL_ONLY");
      },
    };
    return model;
  };
  const models = [makeModel(NCTX_BATCH_MAIN), makeModel(NCTX_BATCH_MAINTENANCE)];
  const factory = ({ selection }: { selection: ModelSelection }): Model => {
    const model = models.find(
      (item) => item.providerId === selection.providerId && item.modelId === selection.modelId,
    );
    assert.ok(model, "the fixture must reject unconfigured fallback models");
    return model;
  };
  return { factory, calls };
}
