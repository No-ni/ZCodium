import { describe, expect, it, vi } from "vitest";
import {
  ModelErrorCode,
  ModelFailureReason,
  ModelProtocolError,
  createModelId,
  createModelProviderId,
  runWithModelInvocationContext,
  type ModelEvent,
  type ModelProperties,
} from "@zcode/contracts";
import {
  createModel as createRawModel,
  type ModelExecutionRequest,
  type ModelExecutor,
} from "../src/model/model.js";
import {
  TestAiSdkModelAdapter as AiSdkModelAdapter,
  TestProviderConfigFixture,
} from "./test-provider-config.js";
import type { AiSdkModelRuntime } from "../src/model/runner-runtime.js";
import { createTestInputFormat } from "./test-model-format.js";

const properties: ModelProperties = {
  requiresMfjsToolSchema: false,
  contextWindow: 128_000,
  inputFormat: {
    supportsText: true,
    supportsImage: true,
    supportsVideo: false,
    supportsAudio: false,
    supportsPdf: false,
  },
  outputFormat: { supportsText: true },
  supportsMidConversationSystem: false,
  supportsNativeWebSearch: false,
  supportsJsonSchemaOutput: true,
  supportsToolCall: true,
};

function createExecutor() {
  const requests: ModelExecutionRequest[] = [];
  const generateText = vi.fn(async (request: ModelExecutionRequest) => {
    requests.push(request);
    return {
      finishReason: "stop",
      providerId: createModelProviderId("test"),
      modelId: createModelId("model-a"),
      text: "done",
      usage: {},
    };
  });
  const executor: ModelExecutor = {
    generateText,
    async *streamText(): AsyncIterable<ModelEvent> {
      yield { type: "start" };
      yield { type: "finish", finishReason: "stop", usage: {} };
    },
  };
  return { executor, generateText, requests };
}

/** 测试夹具必须显式绑定执行预算，不能借已删除的 Option Spec default 偷渡请求值。 */
function createModel(input: Parameters<typeof createRawModel>[0]) {
  const reasoningLevel = input.optionSpecs.reasoningLevel ?? {
    values: ["disabled"],
  };
  return createRawModel({
    ...input,
    optionSpecs: {
      ...input.optionSpecs,
      reasoningLevel,
    },
    options: input.options ?? {
      maxOutputTokens: Math.min(8_000, input.optionSpecs.maxOutputTokens.max),
      reasoningLevel: reasoningLevel.values.at(-1) ?? "disabled",
    },
  });
}

describe("Model", () => {
  it.each(["start-plan", "individual-coding-plan", "team-coding-plan", "off-peak", "highspeed"] as const)(
    "fails closed at binding for retired account mode %s", (accountMode) => {
      const generateText = vi.fn();
      const streamText = vi.fn();
      const adapter = new AiSdkModelAdapter({
        registry: new TestProviderConfigFixture({ providers: { account: { kind: "anthropic", apiKey: "synthetic", baseURL: "https://model.example.test" } } }),
        runtime: { generateText, streamText },
      });
      // 所有旧账号模式在模型绑定时拒绝，不能等到请求阶段才恢复票据流程。
      expect(() => adapter.createModel({ accountMode, providerId: "account" as never, modelId: "model-a" as never, properties, optionSpecs: { maxOutputTokens: { max: 8000 } } })).toThrowError(
        expect.objectContaining({ code: ModelErrorCode.ModelRequestAuthMissing }),
      );
      expect(generateText).not.toHaveBeenCalled();
      expect(streamText).not.toHaveBeenCalled();
    },
  );

  it("applies bound and request options without mutation", async () => {
    const { executor, requests } = createExecutor();
    const base = createModel({
      executor,
      modelId: "model-a",
      optionSpecs: {
        maxOutputTokens: { max: 128_000 },
        reasoningLevel: {
          values: ["low", "medium", "high"],
        },
      },
      properties,
      providerId: "test",
    });

    const bound = base.bind({ maxOutputTokens: 16_000, reasoningLevel: "high" });
    await bound.generateText({
      messages: [{ role: "user", content: "hello" }],
      options: { maxOutputTokens: 4_000, reasoningLevel: "low" },
    });

    expect(base.options).toEqual({ maxOutputTokens: 8_000, reasoningLevel: "high" });
    expect(bound.options).toEqual({ maxOutputTokens: 16_000, reasoningLevel: "high" });
    expect(requests[0]?.options).toEqual({
      maxOutputTokens: 4_000,
      reasoningLevel: "low",
    });
  });

  it("rejects a request without an explicit max output budget", async () => {
    const { executor } = createExecutor();
    const model = createRawModel({
      executor,
      modelId: "model-a",
      optionSpecs: {
        maxOutputTokens: { max: 16_000 },
        reasoningLevel: { values: ["disabled"] },
      },
      properties,
      providerId: "test",
    });

    await expect(
      model.generateText({ messages: [{ role: "user", content: "hello" }] }),
    ).rejects.toMatchObject({ code: ModelErrorCode.InvalidModelRequest });
  });

  it("validates option enum and limit constraints at bind and request boundaries", async () => {
    const { executor } = createExecutor();
    const model = createModel({
      executor,
      modelId: "model-a",
      optionSpecs: {
        maxOutputTokens: { max: 16_000 },
        reasoningLevel: { values: ["low", "high"] },
      },
      properties,
      providerId: "test",
    });

    expect(() => model.bind({ reasoningLevel: "unsupported" })).toThrowError(ModelProtocolError);
    await expect(
      model.generateText({
        messages: [{ role: "user", content: "hello" }],
        options: { maxOutputTokens: 4_000 },
      }),
    ).resolves.toMatchObject({ text: "done" });
    for (const maxOutputTokens of [0, -1, 1.5]) {
      await expect(
        model.generateText({
          messages: [{ role: "user", content: "hello" }],
          options: { maxOutputTokens },
        }),
      ).rejects.toMatchObject({
        code: ModelErrorCode.InvalidModelRequest,
        context: {
          reason: ModelFailureReason.InvalidRequest,
          retryable: false,
          source: "runtime",
        },
      });
    }
    await expect(
      model.generateText({
        messages: [{ role: "user", content: "hello" }],
        options: { maxOutputTokens: 32_000 },
      }),
    ).rejects.toMatchObject({
      code: ModelErrorCode.InvalidModelRequest,
      context: {
        reason: ModelFailureReason.InvalidRequest,
        retryable: false,
        source: "runtime",
      },
    });
  });

  it("validates request features against model properties before execution", async () => {
    const { executor, generateText } = createExecutor();
    const model = createModel({
      executor,
      modelId: "model-a",
      optionSpecs: {
        maxOutputTokens: { max: 8_000 },
      },
      properties: {
        ...properties,
        inputFormat: {
          ...properties.inputFormat,
          supportsImage: false,
          supportsVideo: false,
        },
        supportsJsonSchemaOutput: false,
        supportsToolCall: false,
      },
      providerId: "test",
    });

    await expect(
      model.generateText({
        messages: [{ role: "user", content: "hello" }],
        tools: [{ name: "Read", inputSchema: { type: "object" } }],
      }),
    ).rejects.toMatchObject({
      code: ModelErrorCode.InvalidModelRequest,
      context: {
        reason: ModelFailureReason.InvalidRequest,
        retryable: false,
        source: "runtime",
      },
    });
    await expect(
      model.generateText({
        messages: [{ role: "user", content: "hello" }],
        responseJsonSchema: { type: "object" },
      }),
    ).rejects.toMatchObject({
      code: ModelErrorCode.InvalidModelRequest,
      context: {
        reason: ModelFailureReason.InvalidRequest,
        retryable: false,
        source: "runtime",
      },
    });
    await expect(
      model.generateText({
        messages: [
          {
            role: "user",
            content: [
              { type: "image", dataUrl: "data:image/png;base64,AA==", mediaType: "image/png" },
            ],
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: ModelErrorCode.InvalidModelRequest,
      context: {
        reason: ModelFailureReason.InvalidRequest,
        retryable: false,
        source: "runtime",
      },
    });
    await expect(
      model.generateText({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "file",
                dataUrl: "data:video/mp4;base64,AA==",
                mediaType: "video/mp4",
              },
            ],
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: ModelErrorCode.InvalidModelRequest,
      context: {
        reason: ModelFailureReason.InvalidRequest,
        retryable: false,
        source: "runtime",
      },
    });
    expect(generateText).not.toHaveBeenCalled();
  });

  it("allows media input when the model properties explicitly support it", async () => {
    const { executor, generateText } = createExecutor();
    const model = createModel({
      executor,
      modelId: "model-a",
      optionSpecs: {
        maxOutputTokens: { max: 8_000 },
      },
      properties: {
        ...properties,
        inputFormat: createTestInputFormat(),
      },
      providerId: "test",
    });

    await model.generateText({
      messages: [
        {
          role: "user",
          content: [
            { type: "image", dataUrl: "data:image/png;base64,AA==", mediaType: "image/png" },
            {
              type: "file",
              dataUrl: "data:application/pdf;base64,AA==",
              mediaType: "application/pdf",
            },
          ],
        },
      ],
    });

    expect(generateText).toHaveBeenCalledOnce();
  });

  it("binds Provider headers without exposing them on Model", async () => {
    const receivedHeaders: unknown[] = [];
    const runtime: AiSdkModelRuntime = {
      async generateText(options) {
        receivedHeaders.push(options.headers);
        return {
          finishReason: "stop",
          text: "done",
          totalUsage: {},
          usage: {},
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: new TestProviderConfigFixture({
        providers: {
          test: {
            kind: "custom",
            headers: { "X-Provider": "yes", "X-Shared": "provider" },
            createLanguageModel: () =>
              ({ specificationVersion: "v3", provider: "test", modelId: "a" }) as never,
          },
        },
      }),
      runtime,
    });
    const model = adapter.createModel({
      providerId: "test" as never,
      modelId: "model-a" as never,
      optionSpecs: {
        maxOutputTokens: { max: 8_000 },
      },
      properties,
    });

    await model.generateText({ messages: [{ role: "user", content: "hello" }] });

    expect(receivedHeaders[0]).toMatchObject({
      "X-Provider": "yes",
      "X-Shared": "provider",
    });
    expect(model).not.toHaveProperty("headers");
  });



  it("does not refresh account runtime headers for a model without account access", async () => {
    const refresh = vi.fn(async () => ({
      headersApplied: false,
      requestAuth: { headers: { "X-Account": "unexpected" } },
    }));
    const receivedHeaders: unknown[] = [];
    const runtime: AiSdkModelRuntime = {
      async generateText(options) {
        receivedHeaders.push(options.headers);
        return {
          finishReason: "stop",
          text: "done",
          totalUsage: {},
          usage: {},
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: new TestProviderConfigFixture({
        providers: {
          personal: {
            kind: "custom",
            headers: { Authorization: "Bearer personal-key" },
            createLanguageModel: () =>
              ({ specificationVersion: "v3", provider: "personal", modelId: "a" }) as never,
          },
        },
      }),
      runtime,
    });
    const model = adapter.createModel({
      providerId: "personal" as never,
      modelId: "model-a" as never,
      optionSpecs: {
        maxOutputTokens: { max: 8_000 },
      },
      properties,
    });

    await runWithModelInvocationContext({ refreshRuntimeHeadersBeforeAttempt: refresh }, () =>
      model.generateText({ messages: [{ role: "user", content: "hello" }] }),
    );

    expect(refresh).not.toHaveBeenCalled();
    expect(receivedHeaders[0]).toMatchObject({ Authorization: "Bearer personal-key" });
  });

  it("ignores retired Model-bound request auth while keeping static Provider headers", async () => {
    const resolve = vi
      .fn()
      .mockResolvedValueOnce({ headers: { Authorization: "Bearer first" } })
      .mockResolvedValueOnce({ headers: { Authorization: "Bearer second" } });
    const receivedHeaders: unknown[] = [];
    const runtime: AiSdkModelRuntime = {
      async generateText(options) {
        receivedHeaders.push(options.headers);
        return {
          finishReason: "stop",
          text: "done",
          totalUsage: {},
          usage: {},
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: new TestProviderConfigFixture({
        providers: {
          request: {
            kind: "custom",
            headers: { "X-Static": "yes" },
            createLanguageModel: () =>
              ({ specificationVersion: "v3", provider: "request", modelId: "a" }) as never,
          },
        },
      }),
      runtime,
    });
    const model = adapter.createModel({
      providerId: "request" as never,
      modelId: "model-a" as never,
      optionSpecs: {
        maxOutputTokens: { max: 8_000 },
      },
      properties,
      requestDependencies: { requestAuth: { source: { resolve } } },
    });
    const request = { messages: [{ role: "user" as const, content: "hello" }] };

    await model.generateText(request);
    await model.generateText(request);

    // 旧调用方的 requestAuth 不能重新启用官方账号端口。
    expect(resolve).not.toHaveBeenCalled();
    expect(receivedHeaders).toEqual([
      expect.objectContaining({ "X-Static": "yes" }),
      expect.objectContaining({ "X-Static": "yes" }),
    ]);
    expect(request).not.toHaveProperty("requestAuth");
  });

  it("ignores retired Model-bound request auth for streamed requests", async () => {
    const resolve = vi.fn().mockResolvedValue({
      headers: { Authorization: "Bearer streamed" },
    });
    const receivedHeaders: unknown[] = [];
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText(options) {
        receivedHeaders.push(options.headers);
        return {
          fullStream: (async function* () {
            yield {
              type: "finish",
              finishReason: "stop",
              totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          })(),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: new TestProviderConfigFixture({
        providers: {
          request: {
            kind: "custom",
            headers: { "X-Static": "yes" },
            createLanguageModel: () =>
              ({ specificationVersion: "v3", provider: "request", modelId: "a" }) as never,
          },
        },
      }),
      runtime,
    });
    const model = adapter.createModel({
      providerId: "request" as never,
      modelId: "model-a" as never,
      optionSpecs: {
        maxOutputTokens: { max: 8_000 },
      },
      properties,
      requestDependencies: { requestAuth: { source: { resolve } } },
    });

    const events: ModelEvent[] = [];
    for await (const event of model.streamText({
      messages: [{ role: "user", content: "hello" }],
    })) {
      events.push(event);
    }

    expect(resolve).not.toHaveBeenCalled();
    expect(receivedHeaders).toEqual([
      expect.objectContaining({ "X-Static": "yes" }),
    ]);
    expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "stop" });
  });







  it("keeps bound provider facts stable while rejecting retired request auth overlays", async () => {
    const firstLanguageModel = {
      specificationVersion: "v3",
      provider: "first",
      modelId: "a",
    };
    const secondLanguageModel = {
      specificationVersion: "v3",
      provider: "second",
      modelId: "a",
    };
    const receivedModels: unknown[] = [];
    const receivedHeaders: unknown[] = [];
    const runtime: AiSdkModelRuntime = {
      async generateText(options) {
        receivedModels.push(options.model);
        receivedHeaders.push(options.headers);
        return {
          finishReason: "stop",
          text: "done",
          totalUsage: {},
          usage: {},
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const registry = new TestProviderConfigFixture({
      providers: {
        account: {
          kind: "custom",
          headers: { "X-Provider": "first" },
          createLanguageModel: () => firstLanguageModel as never,
        },
      },
    });
    const adapter = new AiSdkModelAdapter({ registry, runtime });
    const model = adapter.createModel({
      providerId: "account" as never,
      modelId: "model-a" as never,
      optionSpecs: {
        maxOutputTokens: { max: 8_000 },
      },
      properties,
    });

    registry.replaceConfig({
      providers: {
        account: {
          kind: "custom",
          headers: { "X-Provider": "second" },
          createLanguageModel: () => secondLanguageModel as never,
        },
      },
    });

    await runWithModelInvocationContext(
      {
        refreshRuntimeHeadersBeforeAttempt: async () => ({
          headersApplied: true,
          requestAuth: { headers: { "X-Request-Auth": "current" } },
        }),
      },
      () => model.generateText({ messages: [{ role: "user", content: "hello" }] }),
    );

    await runWithModelInvocationContext(
      {
        refreshRuntimeHeadersBeforeAttempt: async () => ({
          headersApplied: true,
          requestAuth: { apiKey: "next-attempt-key" },
        }),
      },
      () => model.generateText({ messages: [{ role: "user", content: "again" }] }),
    );
    const modelCreatedAfterReplacement = adapter.createModel({
      providerId: "account" as never,
      modelId: "model-a" as never,
      optionSpecs: {
        maxOutputTokens: { max: 8_000 },
      },
      properties,
    });
    await modelCreatedAfterReplacement.generateText({
      messages: [{ role: "user", content: "new model" }],
    });

    expect(receivedModels).toHaveLength(3);
    expect(receivedHeaders[0]).toEqual(
      expect.objectContaining({
        "X-Provider": "first",
      }),
    );
    expect(receivedHeaders[1]).toEqual(expect.objectContaining({ "X-Provider": "first" }));
    expect(receivedHeaders[0]).not.toHaveProperty("X-Request-Auth");
    expect(receivedHeaders[1]).not.toHaveProperty("X-Request-Auth");
    expect(receivedHeaders[2]).toEqual(expect.objectContaining({ "X-Provider": "second" }));
  });

  it("does not duplicate effective model options into AI SDK provider options", async () => {
    let receivedProviderOptions: unknown;
    let receivedMaxOutputTokens: unknown;
    const runtime: AiSdkModelRuntime = {
      async generateText(options) {
        receivedProviderOptions = options.providerOptions;
        receivedMaxOutputTokens = options.maxOutputTokens;
        return {
          finishReason: "stop",
          text: "done",
          totalUsage: {},
          usage: {},
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: new TestProviderConfigFixture({
        providers: {
          test: {
            kind: "custom",
            createLanguageModel: () =>
              ({ specificationVersion: "v3", provider: "test", modelId: "a" }) as never,
          },
        },
      }),
      runtime,
    });
    const model = adapter
      .createModel({
        providerId: "test" as never,
        modelId: "model-a" as never,
        optionSpecs: {
          maxOutputTokens: {
            max: 16_000,
            map: '{"max_completion_tokens":maxOutputTokens}',
          },
          reasoningLevel: {
            values: ["low", "high"],
            map: '{"reasoning_effort":reasoningLevel}',
          },
        },
        properties,
      })
      .bind({ reasoningLevel: "high" });

    await model.generateText({
      messages: [{ role: "user", content: "hello" }],
      options: { maxOutputTokens: 4_000 },
    });

    expect(receivedProviderOptions).toEqual({
      apiFormat: "openai-chat-completions",
    });
    expect(receivedMaxOutputTokens).toBeUndefined();
  });
});
