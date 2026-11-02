import { afterEach, describe, expect, it, vi } from "vitest";
import { createGenerateTextOptions, createStreamTextOptions } from "../src/model/runner-options.js";
import type { ResolvedAiSdkModel } from "../src/model/runner-runtime.js";

function resolved(partial: Partial<ResolvedAiSdkModel>): ResolvedAiSdkModel {
  return { properties: {}, ...partial } as ResolvedAiSdkModel;
}

describe("createStreamTextOptions", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("maps a JSON response schema only into generateText structured output", async () => {
    const responseJsonSchema = {
      additionalProperties: false,
      properties: {
        selected_memories: {
          items: { type: "string" },
          type: "array",
        },
      },
      required: ["selected_memories"],
      type: "object",
    };
    const input = {
      request: {
        messages: [{ role: "user" as const, content: "select" }],
        responseJsonSchema,
      },
      resolved: resolved({
        model: {} as ResolvedAiSdkModel["model"],
        providerId: "test-provider",
        modelId: "test-model",
        providerKind: "custom",
      }),
    };

    const generateOptions = createGenerateTextOptions(input);
    const streamOptions = createStreamTextOptions(input);

    expect(generateOptions.output).toBeDefined();
    await expect(generateOptions.output?.responseFormat).resolves.toEqual({
      schema: responseJsonSchema,
      type: "json",
    });
    expect(streamOptions).not.toHaveProperty("output");
  });

  it("keeps explicit generateText schemas on the native Anthropic output format", () => {
    const responseJsonSchema = {
      additionalProperties: false,
      properties: {
        selected_memories: { items: { type: "string" }, type: "array" },
      },
      required: ["selected_memories"],
      type: "object",
    };
    const input = {
      request: {
        messages: [{ role: "user" as const, content: "select" }],
        responseJsonSchema,
      },
      resolved: resolved({
        model: {} as ResolvedAiSdkModel["model"],
        providerId: "test-provider",
        modelId: "lite-model",
        providerKind: "anthropic",
      }),
    };
    const generateInput = {
      ...input,
      request: {
        ...input.request,
        options: { maxOutputTokens: 256 },
        providerOptions: { anthropic: {} },
      },
      resolved: {
        ...input.resolved,
        providerOptions: {
          anthropic: {
            effort: "medium",
            thinking: { budgetTokens: 8_000, type: "enabled" },
          },
        },
      },
    };

    const generateOptions = createGenerateTextOptions(generateInput);
    expect(generateOptions).not.toHaveProperty("maxOutputTokens");
    expect(generateOptions.providerOptions).toEqual({
      anthropic: { structuredOutputMode: "outputFormat" },
    });
    expect(createStreamTextOptions(input).providerOptions).toBeUndefined();
  });

  it("applies the same empty-user wire fallback to generate and stream requests", () => {
    for (const createOptions of [createGenerateTextOptions, createStreamTextOptions]) {
      const options = createOptions({
        request: {
          messages: [{ role: "user", content: "" }],
        },
        resolved: resolved({
          model: {} as ResolvedAiSdkModel["model"],
          providerId: "custom-compatible",
          modelId: "empty-user-model",
          providerKind: "openai-compatible",
          baseURL: "https://api.example.test/v1",
        }),
      });

      expect(options.messages).toEqual([{ role: "user", content: "(no content)" }]);
    }
  });

  it("passes resolved image support into generateText message transforms", () => {
    const options = createGenerateTextOptions({
      request: {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                mediaType: "image/png",
                dataUrl: "data:image/png;base64,aW1hZ2U=",
              },
            ],
          },
        ],
      },
      resolved: resolved({
        properties: {
          inputFormat: { text: true, image: false, audio: false, video: false, pdf: false },
        },
        model: {} as ResolvedAiSdkModel["model"],
        providerId: "zai",
        modelId: "glm-text",
        providerKind: "openai-compatible",
      }),
    });

    expect((options.messages[0] as any).content).toEqual([
      {
        type: "text",
        text: "[Attached image/png]\n[Media omitted from provider request because the selected model does not support image input.]",
      },
    ]);
  });

  it("strips video before the OpenAI Responses adapter sees an unsupported file part", () => {
    for (const createOptions of [createGenerateTextOptions, createStreamTextOptions]) {
      const options = createOptions({
        request: {
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "video",
                  mediaType: "video/mp4",
                  dataUrl: "data:video/mp4;base64,dmlkZW8=",
                },
              ],
            },
          ],
        },
        resolved: resolved({
          properties: {
            inputFormat: { text: true, image: false, audio: false, video: true, pdf: false },
          },
          model: {} as ResolvedAiSdkModel["model"],
          providerId: "openai",
          modelId: "gpt-test",
          providerKind: "openai",
        }),
      });

      expect((options.messages[0] as any).content).toEqual([
        {
          type: "text",
          text: "[Attached video/mp4]\n[Media omitted from provider request because the selected model does not support video input.]",
        },
      ]);
    }
  });

  // 最终输出预算由 Model Option Map 写入原始请求体；runner 不再二次推导、扣减或投影旧字段。
  it.each([createGenerateTextOptions, createStreamTextOptions])(
    "keeps canonical model options out of SDK-specific legacy projection",
    (createOptions) => {
      const options = createOptions({
        request: {
          messages: [{ role: "user", content: "hello" }],
          options: { maxOutputTokens: 20_000, reasoningLevel: "high" },
        },
        resolved: resolved({
          model: {} as ResolvedAiSdkModel["model"],
          providerId: "example",
          modelId: "example-model",
          providerKind: "anthropic",
        }),
      });
      expect(options).not.toHaveProperty("maxOutputTokens");
      expect(options.providerOptions).toBeUndefined();
    },
  );

  it("uses merged Responses provider options while transforming history", () => {
    const toolCallId = "call_read";
    const options = createGenerateTextOptions({
      request: {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "reasoning",
                text: "stored reasoning",
                providerOptions: { openai: { itemId: "rs_1" } },
              },
              { type: "text", text: "checking" },
            ],
            toolCalls: [{ id: toolCallId, name: "Read", input: { file_path: "README.md" } }],
          },
        ],
      },
      resolved: resolved({
        model: {} as ResolvedAiSdkModel["model"],
        providerId: "openai",
        modelId: "gpt-5",
        providerKind: "openai",
        providerOptions: { apiFormat: "openai-responses" },
      }),
    });

    const [message] = options.messages ?? [];
    expect((message as any).content).toEqual([
      { type: "text", text: "checking" },
      {
        type: "tool-call",
        toolCallId,
        toolName: "Read",
        input: { file_path: "README.md" },
      },
    ]);
    expect(options.providerOptions).toEqual({ apiFormat: "openai-responses" });
  });

  it("preserves explicit provider option namespaces without inferring model options", () => {
    for (const createOptions of [createGenerateTextOptions, createStreamTextOptions]) {
      const options = createOptions({
        request: {
          messages: [{ role: "user", content: "Generate a title" }],
          providerOptions: { reasoningEffort: "none" },
        },
        resolved: resolved({
          model: {} as ResolvedAiSdkModel["model"],
          providerKind: "openai",
          providerOptions: { openai: { reasoningEffort: "high", store: false } },
          providerId: "openai",
          modelId: "gpt-5.2",
        }),
      });

      expect(options.providerOptions).toEqual({
        openai: { reasoningEffort: "high", store: false },
        reasoningEffort: "none",
      });
    }
  });
});
