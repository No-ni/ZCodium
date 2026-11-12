import { generateText } from "ai";
import {
  ApiKeyAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
  createRegistryProviderConfig,
  type ProviderApiType,
  type ProviderRequestCompression,
} from "@zcode/provider";
import { describe, expect, it } from "vitest";
import { AiSdkModelExecution } from "../src/model/model-execution.js";

const FIRST_URL = "https://first.fixture.invalid/v1";
const SECOND_URL = "https://second.fixture.invalid/v1";

function bind(
  execution: AiSdkModelExecution,
  providerId = "fixture",
  baseUrl = FIRST_URL,
  type: ProviderApiType = "openai-chat-completions",
  requestCompression: ProviderRequestCompression = "brotli",
) {
  const result = createRegistryProviderConfig(
    new ProviderConfig({
      group: "standard-personal",
      access: new ApiKeyAccessConfig({ apiKey: "e2e-only" }),
      api: new ProviderApiConfig({ type, baseUrl, requestCompression }),
    }),
  );
  if (!result.ok) throw new Error("invalid fixture provider");
  return execution.bindModel({
    providerId,
    modelId: "fixture-model",
    providerConfig: result.config,
    supportsJsonSchemaOutput: false,
    optionSpecs: { reasoningLevel: { map: "{}" }, maxOutputTokens: { map: "{}" } },
  });
}

function generate(binding: ReturnType<typeof bind>) {
  return generateText({
    model: binding.resolveRequest({ options: { reasoningLevel: "disabled", maxOutputTokens: 64 } })
      .model,
    prompt: "E2E_COMPRESSION_SCOPE",
    maxRetries: 0,
  });
}

function success(request: Request): Response {
  return request.url.endsWith("/messages")
    ? Response.json({
        id: "fixture",
        type: "message",
        role: "assistant",
        model: "fixture-model",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    : Response.json({
        id: "fixture",
        object: "chat.completion",
        created: 1,
        model: "fixture-model",
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
}

describe("request compression scope in actual SDK bindings", () => {
  it("shares successful downgrade memory across bindings, isolates providers, and bypasses off", async () => {
    const encodings: Array<string | null> = [];
    const execution = new AiSdkModelExecution(
      { env: {} },
      {
        transport: async (input, init) => {
          const request = new Request(input, init);
          encodings.push(request.headers.get("content-encoding"));
          return encodings.length === 1
            ? new Response("unsupported", { status: 415 })
            : success(request);
        },
      },
    );
    const original = bind(execution);
    await generate(original);
    await generate(bind(execution));
    await generate(bind(execution, "other"));
    await generate(bind(execution, "fixture", FIRST_URL, "openai-chat-completions", "off"));
    await generate(original);
    expect(encodings).toEqual(["br", "gzip", "gzip", "br", null, "gzip"]);
  });

  it("keeps a late old-endpoint downgrade out of new endpoint bindings", async () => {
    const captured: Array<{ host: string; encoding: string | null }> = [];
    let releaseOldRetry: (() => void) | undefined;
    let announceOldRetry: (() => void) | undefined;
    const oldRetryStarted = new Promise<void>((resolve) => {
      announceOldRetry = resolve;
    });
    const execution = new AiSdkModelExecution(
      { env: {} },
      {
        transport: async (input, init) => {
          const request = new Request(input, init);
          captured.push({
            host: new URL(request.url).host,
            encoding: request.headers.get("content-encoding"),
          });
          if (captured.length === 1) return new Response("unsupported", { status: 415 });
          if (captured.length === 2) {
            await new Promise<void>((resolve) => {
              releaseOldRetry = resolve;
              announceOldRetry!();
            });
          }
          return success(request);
        },
      },
    );
    const oldBinding = bind(execution);
    const oldPending = generate(oldBinding);
    try {
      await oldRetryStarted;
      await generate(bind(execution, "fixture", SECOND_URL));
    } finally {
      releaseOldRetry?.();
      await oldPending;
    }
    await generate(bind(execution, "fixture", SECOND_URL));
    await generate(oldBinding);
    expect(captured).toEqual([
      { host: "first.fixture.invalid", encoding: "br" },
      { host: "first.fixture.invalid", encoding: "gzip" },
      { host: "second.fixture.invalid", encoding: "br" },
      { host: "second.fixture.invalid", encoding: "br" },
      { host: "first.fixture.invalid", encoding: "gzip" },
    ]);
  });

  it("probes a new API protocol independently on the same provider and endpoint", async () => {
    const encodings: Array<string | null> = [];
    const execution = new AiSdkModelExecution(
      { env: {} },
      {
        transport: async (input, init) => {
          const request = new Request(input, init);
          encodings.push(request.headers.get("content-encoding"));
          return encodings.length === 1
            ? new Response("unsupported", { status: 415 })
            : success(request);
        },
      },
    );
    await generate(bind(execution));
    await generate(bind(execution, "fixture", FIRST_URL, "anthropic-messages"));
    await generate(bind(execution));
    expect(encodings).toEqual(["br", "gzip", "br", "gzip"]);
  });
});
