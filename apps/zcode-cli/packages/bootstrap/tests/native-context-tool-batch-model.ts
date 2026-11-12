import assert from "node:assert/strict";
import {
  AiSdkModelAdapter,
  createModel,
  type CreateAiSdkModelOptions,
} from "@zcode/adapters/model";
import {
  createModelId,
  createModelProviderId,
  getCurrentModelInvocationContext,
  ModelTransportKind,
  type ModelEvent,
  type ModelRequest,
  type ModelResult,
  type ModelSelection,
} from "@zcode/contracts";

export const BATCH_MAIN = {
  providerId: "nctx-bootstrap",
  modelId: "batch-main",
  options: { reasoningLevel: "medium" },
} satisfies ModelSelection;
export const BATCH_MAINTENANCE = {
  providerId: "nctx-bootstrap",
  modelId: "batch-maintenance",
  options: { reasoningLevel: "medium" },
} satisfies ModelSelection;
export const BATCH_TOOLS = ["NctxBootstrapFirst", "NctxBootstrapSecond"] as const;
export const BATCH_CALL_IDS = ["bootstrap-first-call", "bootstrap-second-call"] as const;
export const BATCH_OLD_TEXT =
  "Synthetic completed investigation: retain its decision, identifiers and outstanding constraints. ".repeat(
    110,
  );
export const BATCH_SUMMARY =
  "Synthetic summary: the historical investigation completed; retain its decision, identifiers and outstanding constraints.";
export const BATCH_FINAL_TEXT = "Synthetic final answer after both read-only tool observations.";
export const BATCH_FIRST_INPUT = "NCTX09_FIRST_FIFO_INPUT";
export const BATCH_SECOND_INPUT = "NCTX09_SECOND_FIFO_INPUT";
export const BATCH_MAIN_USAGE = { inputTokens: 320, outputTokens: 9, cacheReadTokens: 0 };
export const BATCH_MAINTENANCE_USAGE = { inputTokens: 40, outputTokens: 8, cacheReadTokens: 0 };

export function batchSignal() {
  return Promise.withResolvers<void>();
}
export interface BatchPhysicalCall {
  requestId: string;
  querySource: string;
  model: ModelSelection;
  request: ModelRequest;
}

/** 仅注入 Provider 传输；实际 invocation/statusSink、scheduler、executor 均沿产品入口执行。 */
export class BootstrapBatchModelAdapter extends AiSdkModelAdapter {
  readonly calls: BatchPhysicalCall[] = [];
  readonly failure = Promise.withResolvers<never>();
  private mainCalls = 0;

  constructor(
    private readonly fixture: {
      order: string[];
      finalEntered: ReturnType<typeof batchSignal>;
      finalRelease: ReturnType<typeof batchSignal>;
      maintenanceEntered: ReturnType<typeof batchSignal>;
      maintenanceRelease: ReturnType<typeof batchSignal>;
      beforeFinal(): Promise<void>;
      beforeMaintenance(): Promise<void>;
    },
    env: NodeJS.ProcessEnv,
  ) {
    super({
      env,
      transport: async () => {
        throw new Error("NCTX_BOOTSTRAP_NETWORK_FORBIDDEN");
      },
    });
    void this.failure.promise.catch(() => undefined);
  }

  override createModel(input: CreateAiSdkModelOptions) {
    assert.equal(input.providerId, BATCH_MAIN.providerId);
    assert.ok([BATCH_MAIN.modelId, BATCH_MAINTENANCE.modelId].includes(input.modelId));
    return createModel({
      providerId: createModelProviderId(input.providerId),
      modelId: createModelId(input.modelId),
      properties: input.modelConfig.properties,
      optionSpecs: input.modelConfig.optionSpecs,
      options: input.options,
      displayName: input.displayName,
      executor: {
        generateText: (request) =>
          this.execute(request, input).catch((error: unknown) => {
            this.failure.reject(error);
            throw error;
          }),
        streamText: (request) => this.stream(request, input),
      },
    });
  }

  private async execute(
    request: ModelRequest,
    input: CreateAiSdkModelOptions,
  ): Promise<ModelResult> {
    const context = getCurrentModelInvocationContext();
    assert.ok(context?.traceContext && context.statusSink);
    const call: BatchPhysicalCall = {
      requestId: `bootstrap-physical-${this.calls.length + 1}`,
      model: { providerId: input.providerId, modelId: input.modelId },
      request,
      querySource: String(context.metadata?.querySource ?? "main"),
    };
    this.calls.push(call);
    const startedAt = Date.now();
    const identity = {
      requestId: call.requestId,
      providerId: createModelProviderId(input.providerId),
      modelId: createModelId(input.modelId),
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
    const result =
      input.modelId === BATCH_MAINTENANCE.modelId
        ? await this.maintenanceResult(request, call)
        : await this.mainResult(request);
    await context.statusSink.publish({
      ...identity,
      type: "model_request_completed",
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      finishReason: result.finishReason,
      usage: result.usage,
    });
    return result;
  }

  private async mainResult(request: ModelRequest): Promise<ModelResult> {
    this.mainCalls++;
    assert.ok(this.mainCalls <= 5, "no extra main request or hidden retry");
    if (this.mainCalls === 2) {
      assert.ok(BATCH_TOOLS.every((name) => request.tools?.some((tool) => tool.name === name)));
      this.fixture.order.push("main-tool-calls");
      return {
        text: "",
        finishReason: "tool-calls",
        usage: BATCH_MAIN_USAGE,
        reasoning: [],
        toolCalls: BATCH_TOOLS.map((name, index) => ({
          id: BATCH_CALL_IDS[index]!,
          name,
          input: { slot: index === 0 ? "first" : "second" },
        })),
      };
    }
    if (this.mainCalls === 3) {
      await this.fixture.beforeFinal();
      this.fixture.order.push("final-pending");
      this.fixture.finalEntered.resolve();
      await this.fixture.finalRelease.promise;
      request.abortSignal?.throwIfAborted();
    }
    if (this.mainCalls >= 4) {
      const expected = this.mainCalls === 4 ? BATCH_FIRST_INPUT : BATCH_SECOND_INPUT;
      const lastUser = request.messages.findLast((message) => message.role === "user");
      assert.ok(typeof lastUser?.content === "string" && lastUser.content.includes(expected));
      this.fixture.order.push(this.mainCalls === 4 ? "fifo-first-model" : "fifo-second-model");
    }
    return {
      text: this.mainCalls === 1 ? BATCH_OLD_TEXT : BATCH_FINAL_TEXT,
      finishReason: "stop",
      usage: BATCH_MAIN_USAGE,
      reasoning: [],
      toolCalls: [],
    };
  }

  private async maintenanceResult(
    request: ModelRequest,
    call: BatchPhysicalCall,
  ): Promise<ModelResult> {
    assert.equal(call.querySource, "native_context_maintenance");
    await this.fixture.beforeMaintenance();
    this.fixture.order.push("maintenance-model");
    this.fixture.maintenanceEntered.resolve();
    await this.fixture.maintenanceRelease.promise;
    request.abortSignal?.throwIfAborted();
    const lastUser = request.messages.findLast((message) => message.role === "user");
    assert.equal(typeof lastUser?.content, "string");
    const offered = JSON.parse(lastUser!.content as string) as {
      ranges: { startRef: string; endRef: string; source: string }[];
    };
    assert.ok(offered.ranges.length > 0, "a real complete historical range must be offered");
    assert.ok(offered.ranges.some((range) => range.source.includes(BATCH_OLD_TEXT.trim())));
    return {
      text: JSON.stringify({
        ranges: offered.ranges.map((range) => ({
          startRef: range.startRef,
          endRef: range.endRef,
          summary: BATCH_SUMMARY,
        })),
      }),
      finishReason: "stop",
      usage: BATCH_MAINTENANCE_USAGE,
      reasoning: [],
      toolCalls: [],
    };
  }

  private async *stream(
    request: ModelRequest,
    input: CreateAiSdkModelOptions,
  ): AsyncIterable<ModelEvent> {
    const result = await this.execute(request, input).catch((error: unknown) => {
      this.failure.reject(error);
      throw error;
    });
    yield { type: "start" };
    for (const toolCall of result.toolCalls ?? []) yield { type: "tool_call", toolCall };
    if (result.text) {
      yield { type: "text_start", id: "bootstrap-batch-text" };
      yield { type: "text_delta", id: "bootstrap-batch-text", text: result.text };
      yield { type: "text_end", id: "bootstrap-batch-text" };
    }
    yield { type: "finish", finishReason: result.finishReason, usage: result.usage };
  }
}
