import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { fetchCodingPlanQuota, resolveCodingPlanQuotaUrl } = await tsImport(
  "../../packages/services/src/usage-stats/codingPlanQuota.ts",
  import.meta.url,
);
const { createUsageStatsService } = await tsImport(
  "../../packages/services/src/usage-stats/usageStatsService.ts",
  import.meta.url,
);
const BIGMODEL = "https://open.bigmodel.cn/api/anthropic";
const ZAI = "https://api.z.ai/api/anthropic";
const success = (remaining = 3) => ({
  success: true,
  data: {
    level: "pro",
    limits: [
      { type: "TIME_LIMIT", remaining, number: 10, percentage: 70, nextResetTime: 1790000000000 },
    ],
  },
});
function client(body = success(), status = 200) {
  const calls = [];
  return {
    calls,
    async request(url, init) {
      calls.push({ url, init });
      return {
        ok: status >= 200 && status < 300,
        status,
        async json() {
          return body;
        },
      };
    },
  };
}
function provider(id = "first", key = "fixture-key", baseUrl = BIGMODEL, extra = {}) {
  return {
    providerId: id,
    providerName: id,
    enabled: true,
    personalConfig: {},
    models: [],
    effectiveConfig: {
      access: { type: "zhipu-coding-plan-api-key", apiKey: key },
      api: { baseUrl },
    },
    ...extra,
  };
}
function host(providers = [provider()], apiClient = client()) {
  let revision = 0;
  let current = { revision, providers };
  const listeners = new Set();
  const service = createUsageStatsService({
    apiClient,
    zcodeAgentService: { getAppUsageStats: async () => ({ source: "agent-db" }) },
    providerSettingsService: {
      async getView() {
        return current;
      },
      onDidChange(listener) {
        listeners.add(listener);
        return {
          dispose() {
            listeners.delete(listener);
          },
        };
      },
    },
  });
  return {
    service,
    apiClient,
    listeners,
    change(next) {
      current = { revision: ++revision, providers: next };
      for (const fn of listeners) fn(current);
    },
  };
}

test("exact HTTPS vendor allowlist, no suffix/port/userinfo/proxy guesses", () => {
  assert.deepEqual(resolveCodingPlanQuotaUrl(BIGMODEL), {
    family: "bigmodel",
    url: "https://bigmodel.cn/api/monitor/usage/quota/limit",
  });
  assert.deepEqual(resolveCodingPlanQuotaUrl(ZAI), {
    family: "zai",
    url: "https://api.z.ai/api/monitor/usage/quota/limit",
  });
  for (const url of [
    "",
    "http://api.z.ai/v1",
    "https://api.z.ai:444/v1",
    "https://user@api.z.ai/v1",
    "https://evil.api.z.ai/v1",
    "https://api.z.ai.evil.invalid/v1",
    "https://proxy.invalid/v1",
  ]) {
    assert.equal(resolveCodingPlanQuotaUrl(url), null, url);
  }
});
test("bare Host key and redirect rejection; never custom endpoint or headers", async () => {
  const apiClient = client();
  const result = await fetchCodingPlanQuota({
    apiClient,
    baseUrl: BIGMODEL,
    apiKey: " fixture-key ",
  });
  assert.equal(result.success, true);
  assert.equal(apiClient.calls[0].init.headers.authorization, "fixture-key");
  assert.equal(apiClient.calls[0].init.redirect, "error");
  assert.equal(apiClient.calls[0].url, "https://bigmodel.cn/api/monitor/usage/quota/limit");
  assert.equal(result.snapshot.limits[0].percentage, 0.7);
});
test("missing Key and unsupported endpoint have no network IO", async () => {
  const apiClient = client();
  for (const options of [
    { apiKey: " ", baseUrl: BIGMODEL },
    { apiKey: "key", baseUrl: "https://proxy.invalid" },
  ]) {
    assert.equal((await fetchCodingPlanQuota({ apiClient, ...options })).success, false);
  }
  assert.equal(apiClient.calls.length, 0);
});
test("empty data differs from zero and malformed finite values", async () => {
  for (const body of [{ success: true }, { success: true, data: null }, { data: { limits: [] } }]) {
    const result = await fetchCodingPlanQuota({
      apiClient: client(body),
      apiKey: "key",
      baseUrl: ZAI,
    });
    assert.equal(result.success, true);
    assert.deepEqual(result.snapshot.limits, []);
    assert.equal(result.snapshot.remaining, null);
  }
  const zero = await fetchCodingPlanQuota({
    apiClient: client(success(0)),
    apiKey: "key",
    baseUrl: ZAI,
  });
  assert.equal(zero.snapshot.remaining.remaining, 0);
  for (const body of [
    null,
    [],
    { data: { limits: [{}] } },
    success(-1),
    { data: { limits: [{ type: "TIME_LIMIT", remaining: Infinity }] } },
    { data: { limits: [{ type: "TIME_LIMIT", percentage: 101 }] } },
  ]) {
    const result = await fetchCodingPlanQuota({
      apiClient: client(body),
      apiKey: "key",
      baseUrl: ZAI,
    });
    assert.equal(result.success, false);
    assert.equal(result.error.code, "invalid-response");
  }
});
test("business, HTTP and thrown errors never leak response bodies/keys", async () => {
  const secret = "fixture-sensitive-key";
  for (const apiClient of [
    client({ success: false, msg: secret }),
    client({ code: 401, message: secret }),
    client({ msg: secret }, 401),
    {
      async request() {
        throw new Error(secret);
      },
    },
  ]) {
    const result = await fetchCodingPlanQuota({ apiClient, apiKey: secret, baseUrl: BIGMODEL });
    assert.equal(result.success, false);
    assert.doesNotMatch(JSON.stringify(result), /fixture-sensitive-key/);
  }
});
test("service picks first enabled personal dedicated Key, not standard/account/team/proxy", async () => {
  const invalid = [
    provider("disabled", "key", BIGMODEL, { enabled: false }),
    provider("builtin", "key", BIGMODEL, { personalConfig: undefined }),
    provider("empty", " "),
    provider("proxy", "key", "https://proxy.invalid/v1"),
    provider("standard", "key", BIGMODEL, {
      effectiveConfig: { access: { type: "api-key", apiKey: "key" }, api: { baseUrl: BIGMODEL } },
    }),
    provider("team", "key", BIGMODEL, {
      effectiveConfig: {
        access: { type: "zhipu-coding-plan-api-key", apiKey: "key" },
        api: { baseUrl: BIGMODEL, headers: { "X-Project-ID": "project" } },
      },
    }),
  ];
  const target = host([...invalid, provider("chosen", "host-only-key"), provider("second")]);
  const context = await target.service.getCodingPlanQuotaContext();
  assert.equal(context.providerId, "chosen");
  assert.doesNotMatch(JSON.stringify(context), /host-only-key/);
  const snapshot = await target.service.getCodingPlanQuota({ contextId: context.contextId });
  assert.equal(snapshot.remaining.remaining, 3);
  assert.equal(target.apiClient.calls[0].init.headers.authorization, "host-only-key");
  target.change(invalid);
  assert.equal((await target.service.getCodingPlanQuotaContext()).status, "unavailable");
  await assert.rejects(target.service.getCodingPlanQuota({ contextId: context.contextId }));
  assert.equal(target.apiClient.calls.length, 1);
});
test("opaque generation changes only for quota credential context; event subscription disposes", async () => {
  const target = host();
  const events = [];
  const stop = target.service.onDidChangeCodingPlanQuotaContext((value) => events.push(value));
  const first = await target.service.getCodingPlanQuotaContext();
  target.change([provider("first", "fixture-key", BIGMODEL, { providerName: "renamed" })]);
  assert.equal((await target.service.getCodingPlanQuotaContext()).contextId, first.contextId);
  target.change([provider("first", "next-key")]);
  const next = await target.service.getCodingPlanQuotaContext();
  assert.notEqual(next.contextId, first.contextId);
  assert.equal(events.at(-1).contextId, next.contextId);
  assert.doesNotMatch(JSON.stringify(events), /next-key|fixture-key/);
  await assert.rejects(
    target.service.getCodingPlanQuota({ contextId: first.contextId }),
    /context-changed/,
  );
  stop.dispose();
  assert.equal(target.listeners.size, 0);
});
test("inflight quota is rejected after Host key/provider disappears", async () => {
  let release;
  const apiClient = {
    async request() {
      return await new Promise((resolve) => {
        release = () =>
          resolve({
            ok: true,
            status: 200,
            async json() {
              return success();
            },
          });
      });
    },
  };
  const target = host([provider()], apiClient);
  const context = await target.service.getCodingPlanQuotaContext();
  const pending = target.service.getCodingPlanQuota({ contextId: context.contextId });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  target.change([]);
  release();
  await assert.rejects(pending, /context-changed/);
});
test("serialized RPC forwards opaque quota context, subscribes, disposes and resubscribes", async () => {
  const { ChannelClient, ChannelServer, Emitter, ProxyChannel } = await tsImport(
    "../../packages/rpc/src/index.ts",
    import.meta.url,
  );
  const target = host();
  const input = new Emitter();
  const output = new Emitter();
  const wire = [];
  const client = new ChannelClient({
    onMessage: output.event,
    send(buffer) {
      wire.push(buffer.toString());
      input.fire(buffer);
    },
  });
  const server = new ChannelServer(
    {
      onMessage: input.event,
      send(buffer) {
        wire.push(buffer.toString());
        output.fire(buffer);
      },
    },
    "quota-fixture",
  );
  server.registerChannel("usage-stats", ProxyChannel.fromService(target.service));
  const remote = ProxyChannel.toService(client.getChannel("usage-stats"));
  const events = [];
  let stop;
  try {
    stop = remote.onDidChangeCodingPlanQuotaContext((context) => events.push(context));
    const first = await remote.getCodingPlanQuotaContext();
    assert.equal(target.listeners.size, 1);
    assert.match(first.contextId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(Object.keys(first).sort(), [
      "contextId",
      "family",
      "providerId",
      "providerName",
      "status",
    ]);
    assert.equal(
      (await remote.getCodingPlanQuota({ contextId: first.contextId })).remaining.remaining,
      3,
    );
    target.change([provider("first", "next-host-key")]);
    const next = events.at(-1);
    assert.notEqual(next.contextId, first.contextId);
    await assert.rejects(
      remote.getCodingPlanQuota({ contextId: first.contextId }),
      /context-changed/,
    );
    stop.dispose();
    assert.equal(target.listeners.size, 0);
    const count = events.length;
    target.change([provider("first", "unobserved-host-key")]);
    assert.equal(events.length, count);
    stop = remote.onDidChangeCodingPlanQuotaContext((context) => events.push(context));
    assert.equal(target.listeners.size, 1);
    const resubscribed = await remote.getCodingPlanQuotaContext();
    assert.notEqual(resubscribed.contextId, next.contextId);
    target.change([]);
    assert.deepEqual(events.at(-1), { status: "unavailable", reason: "no-provider" });
    stop.dispose();
    assert.equal(target.listeners.size, 0);
    assert.doesNotMatch(
      wire.join("\n"),
      /fixture-key|next-host-key|unobserved-host-key|apiKey|baseUrl|authorization/,
    );
  } finally {
    stop?.dispose();
    client.dispose();
    server.dispose();
    input.dispose();
    output.dispose();
  }
});

test("invalid JSON rejects without exposing a body or credential", async () => {
  const result = await fetchCodingPlanQuota({
    apiClient: {
      async request() {
        return {
          ok: true,
          status: 200,
          async json() {
            throw new SyntaxError("fixture-secret");
          },
        };
      },
    },
    apiKey: "fixture-secret",
    baseUrl: BIGMODEL,
  });
  assert.equal(result.success, false);
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret/);
});

test("quota context is rechecked after getView resolves and before network admission", async () => {
  const target = microtaskContextChangeHost(2);
  const context = await target.service.getCodingPlanQuotaContext();
  await assert.rejects(
    target.service.getCodingPlanQuota({ contextId: context.contextId }),
    /context-changed/,
  );
  assert.equal(target.apiClient.calls.length, 0, "old context must never borrow the new Key");
});

test("quota context is rechecked after the final read before accepting a snapshot", async () => {
  const target = microtaskContextChangeHost(3);
  const context = await target.service.getCodingPlanQuotaContext();
  await assert.rejects(
    target.service.getCodingPlanQuota({ contextId: context.contextId }),
    /context-changed/,
  );
  assert.equal(target.apiClient.calls.length, 1);
  assert.equal(target.apiClient.calls[0].init.headers.authorization, "fixture-key");
});

function microtaskContextChangeHost(changingRead) {
  let reads = 0;
  let view = { revision: 0, providers: [provider()] };
  const apiClient = client();
  const listeners = new Set();
  const service = createUsageStatsService({
    apiClient,
    zcodeAgentService: { getAppUsageStats: async () => ({}) },
    providerSettingsService: {
      async getView() {
        const captured = view;
        if (++reads === changingRead) {
          queueMicrotask(() =>
            queueMicrotask(() => {
              view = { revision: 1, providers: [provider("first", "next-key")] };
              for (const listener of listeners) listener(view);
            }),
          );
        }
        return captured;
      },
      onDidChange(listener) {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
    },
  });
  service.onDidChangeCodingPlanQuotaContext(() => {});
  return { service, apiClient };
}

test("quota is never cached and remote unavailable does not fallback local", async () => {
  const target = host();
  const context = await target.service.getCodingPlanQuotaContext();
  await target.service.getCodingPlanQuota({ contextId: context.contextId });
  await target.service.getCodingPlanQuota({ contextId: context.contextId });
  assert.equal(target.apiClient.calls.length, 2);
  const unavailable = createUsageStatsService({
    zcodeAgentService: { getAppUsageStats: async () => ({}) },
  });
  await assert.rejects(unavailable.getCodingPlanQuotaContext(), /unavailable/);
});
