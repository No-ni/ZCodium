import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelNetworkStatusEvent, ModelRequestSessionType } from "@zcode/contracts";
import { TestAiSdkModelAdapter, TestProviderConfigFixture } from "./test-provider-config.js";
import { executeAdapterGenerateText, executeAdapterStreamText } from "./test-adapter-model.js";

const QUERY_SOURCE_HEADER = "x-zcode-query-source";
const CAPTURE_ERROR = "query source captured";
afterEach(() => vi.unstubAllGlobals());
const providerKinds = ["anthropic", "openai", "openai-compatible"] as const;
const querySources = [
  "main_turn",
  "subagent",
  "compact",
  "session_title",
  "goal_summary_title",
  "project_memory_extract",
  "project_memory_dream",
  "project_memory_recall",
  "future.source:v2-test",
] as const;

describe.each(providerKinds)("%s explicit provider headers and private request attribution", (providerKind) => {
  it.each([false, true])("side_chat 与请求用途不自动写入 HTTP header，streaming=%s", async (streaming) => {
    const { adapter, requests } = createCapture(providerKind);
    const sources = ["main_turn", "compact", "session_title", "project_memory_recall"];
    for (const source of sources) {
      await captureCall(adapter, source, streaming, [], "side_chat");
    }
    expect(
      requests.map((request) => [
        request.headers.get("x-zcode-session-type"),
        request.headers.get(QUERY_SOURCE_HEADER),
      ]),
    ).toEqual(sources.map(() => [null, "configured_provider"]));
  });

  it.each([false, true])("并发用途保持内部归属并保留显式 provider header，streaming=%s", async (streaming) => {
    const { adapter, requests } = createCapture(providerKind);
    await Promise.all(
      querySources.map((querySource) => captureCall(adapter, querySource, streaming)),
    );

    expect(requests).toHaveLength(querySources.length);
    expect(requests.map((request) => request.headers.get(QUERY_SOURCE_HEADER)).sort()).toEqual(
      querySources.map(() => "configured_provider"),
    );
    for (const request of requests) {
      expect(request.headers.get("x-session-id")).toBeNull();
      expect(request.headers.get("x-zcode-session-type")).toBeNull();
      expect(request.headers.get("x-static-marker")).toBe("preserved");
      expect(await request.json()).not.toHaveProperty("querySource");
    }
  });

  it.each([false, true])("缺失或非法内部来源不改写显式 header，streaming=%s", async (streaming) => {
    const { adapter, requests } = createCapture(providerKind);
    const invalidSources = [
      undefined,
      "",
      "   ",
      "compact\r\nx-injected: yes",
      "记忆",
      "a".repeat(129),
      42,
    ];
    for (const querySource of invalidSources) await captureCall(adapter, querySource, streaming);

    expect(requests).toHaveLength(invalidSources.length);
    expect(requests.every((request) => request.headers.get(QUERY_SOURCE_HEADER) === "configured_provider")).toBe(true);
  });

  it.each([false, true])("其他归因头保持既有 SDK 合并行为，streaming=%s", async (streaming) => {
    const staticHeaders = {
      "X-Request-ID": "static-request",
      "X-Session-ID": "static-session",
      "X-ZCode-Session-Type": "other",
      "X-ZCode-Trace-ID": "static-trace",
    };
    const events: ModelNetworkStatusEvent[] = [];
    const { adapter, requests } = createCapture(providerKind, false, staticHeaders);
    await captureCall(adapter, "compact", streaming, events);

    expect(requests).toHaveLength(1);
    const started = events.find((event) => event.type === "model_request_started")!;
    expect(started).toBeDefined();
    // 用户显式配置的 API header 按 SDK 合同保留，不注入本仓内部归属覆盖它。
    const expectedHeaders = staticHeaders;
    for (const [name, value] of Object.entries(expectedHeaders)) {
      expect(requests[0]!.headers.get(name)).toBe(value);
    }
    expect(requests[0]!.headers.get(QUERY_SOURCE_HEADER)).toBe("configured_provider");
  });

  it.each([false, true])(
    "重试保留显式 header且不向外发送内部 request id，streaming=%s",
    async (streaming) => {
      const events: ModelNetworkStatusEvent[] = [];
      const { adapter, requests } = createCapture(providerKind, true);
      await captureCall(adapter, "  compact  ", streaming, events);

      expect(requests).toHaveLength(2);
      expect(requests.map((request) => request.headers.get(QUERY_SOURCE_HEADER))).toEqual([
        "configured_provider",
        "configured_provider",
      ]);
      expect(requests.every((request) => !request.headers.has("x-request-id"))).toBe(true);
      expect(events.filter((event) => event.type === "model_request_started")).toHaveLength(2);
    },
  );
});

function createCapture(
  providerKind: (typeof providerKinds)[number],
  retry = false,
  headers: Record<string, string> = {},
) {
  const requests: Request[] = [];
  const transport: typeof fetch = async (input, init) => {
    requests.push(new Request(input, init));
    return Response.json(
      { type: "error", error: { type: "invalid_request_error", message: CAPTURE_ERROR } },
      { status: retry && requests.length === 1 ? 503 : 400 },
    );
  };
  vi.stubGlobal("fetch", transport);
  const registry = new TestProviderConfigFixture({
    env: {},
    defaultHeaders: { "X-ZCode-Query-Source": "stale_default" },
    providers: {
      fixture: {
        kind: providerKind,
        apiKey: "fake-key",
        baseURL: "https://provider.example.test/v1",
        headers: {
          "x-zcode-query-source": "configured_provider",
          "x-static-marker": "preserved",
          ...headers,
        },
      },
    },
  });
  const adapter = new TestAiSdkModelAdapter({
    registry,
    retry: { baseDelayMs: 0, maxDelayMs: 0, jitter: false, maxAttempts: retry ? 2 : 1 },
  });
  return { adapter, requests };
}

async function captureCall(
  adapter: TestAiSdkModelAdapter,
  querySource: unknown,
  streaming: boolean,
  events: ModelNetworkStatusEvent[] = [],
  sessionType: ModelRequestSessionType = "main",
) {
  const request = {
    providerId: "fixture" as never,
    modelId: "model-a" as never,
    modelRequestSessionType: sessionType,
    messages: [{ role: "user" as const, content: "header capture" }],
    metadata: {
      querySource,
      sessionId:
        typeof querySource === "string" && querySource.trim()
          ? `sess_${querySource.trim().replace(/[^a-zA-Z0-9_.:-]/gu, "_")}`
          : "sess_missing",
      // Memory 的 transcript 开关与内部来源一样留在运行时边界。
      skipTranscript: true,
    },
    statusSink: {
      publish: (event: ModelNetworkStatusEvent) => {
        events.push(event);
      },
    },
  };
  const send = async () => {
    if (streaming) {
      for await (const _event of executeAdapterStreamText(adapter, request)) {
        // 消费到 transport 返回的预期捕获错误。
      }
    } else {
      await executeAdapterGenerateText(adapter, request);
    }
  };
  await expect(send()).rejects.toThrow("Provider rejected the model request.");
}
