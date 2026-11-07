import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { createCodingPlanSubscriptionService } = await tsImport(
  "../../packages/services/src/coding-plan-subscription/codingPlanSubscriptionService.ts",
  import.meta.url,
);
const { createUsageStatsService } = await tsImport(
  "../../packages/services/src/usage-stats/usageStatsService.ts",
  import.meta.url,
);
const { ProxyChannel } = await tsImport("../../packages/rpc/src/proxy-channel.ts", import.meta.url);

test("retired payment RPC cannot read credentials or contact a payment endpoint", async () => {
  const forbidden = () => {
    throw new Error("Payment IO must not occur");
  };
  const service = createCodingPlanSubscriptionService({
    apiClient: new Proxy({}, { get: () => forbidden }),
    credentialService: { load: forbidden },
  });
  const channel = ProxyChannel.fromService(service);
  for (const command of [
    "preview",
    "batchPreview",
    "getStaticProducts",
    "getStartPlanPreview",
    "productInfo",
    "createSign",
    "updateSign",
    "checkPayment",
    "checkPendingOrders",
    "queryStripeCards",
    "bindStripeCard",
    "unbindStripeCard",
    "payStripe",
    "checkPaypalSupport",
    "createPaypalSetupToken",
    "subscribePaypal",
    "getEnterpriseBalance",
    "calculateEnterpriseOrder",
    "createEnterpriseOrder",
    "getEnterprisePendingOrders",
    "cancelEnterpriseOrder",
    "continueEnterpriseOrderPayment",
    "checkEnterpriseOrderStatus",
    "getEnterprisePricing",
    "getStaticTeamProducts",
    "getForceUpdateConfig",
    "getModelContextBudgetStrategy",
  ]) {
    await assert.rejects(
      async () => channel.call(undefined, command, [{ providerId: "fixture", bizId: "fixture" }]),
      /Method not found/,
    );
  }
});

test("local App Usage still reads Agent statistics without any account or payment IO", async () => {
  const forbidden = () => {
    throw new Error("Official IO must not occur");
  };
  const requests = [];
  const result = { fixture: "local usage" };
  const service = createUsageStatsService({
    apiClient: new Proxy({}, { get: () => forbidden }),
    credentialService: { load: forbidden },
    accountRequestAuthService: new Proxy({}, { get: () => forbidden }),
    zcodeAgentService: {
      getAppUsageStats: async (request) => {
        requests.push(request);
        return result;
      },
    },
  });
  assert.equal(await service.getAppUsageSnapshot({ range: "week", timeZone: "UTC" }), result);
  assert.deepEqual(requests, [{ range: "week", timeZone: "UTC" }]);
});

test("remaining workflow configuration is local-only and never contacts official config", async (t) => {
  const key = "ZCODE_DYNAMIC_WORKFLOW_MODE";
  const previous = process.env[key];
  delete process.env[key];
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
  const forbidden = () => {
    throw new Error("Official IO must not occur");
  };
  // 任何 apiClient / credentialService 访问都会抛错：默认路径不得发起请求或读取账号。
  const service = createCodingPlanSubscriptionService({
    apiClient: new Proxy({}, { get: () => forbidden }),
    credentialService: new Proxy({}, { get: () => forbidden }),
  });

  // 修复依据：当前共享快照始终含 offeredMode；无用户选择时它等于生效模式。
  // 未设置 env 时默认 disabled，且 forceRefresh 也不会触发远端读取。
  assert.deepEqual(await service.getDynamicWorkflowClientConfig(), {
    mode: "disabled",
    enabled: false,
    source: "default",
    offeredMode: "disabled",
  });
  assert.deepEqual(await service.getDynamicWorkflowClientConfig({ forceRefresh: true }), {
    mode: "disabled",
    enabled: false,
    source: "default",
    offeredMode: "disabled",
  });

  // 只有显式 env 覆盖才开启，source 固定为 override。
  process.env[key] = "alwaysOn";
  assert.deepEqual(await service.getDynamicWorkflowClientConfig(), {
    mode: "alwaysOn",
    enabled: true,
    source: "override",
    offeredMode: "alwaysOn",
  });
  process.env[key] = "onDemand";
  assert.deepEqual(await service.getDynamicWorkflowClientConfig({ forceRefresh: true }), {
    mode: "onDemand",
    enabled: true,
    source: "override",
    offeredMode: "onDemand",
  });
});
