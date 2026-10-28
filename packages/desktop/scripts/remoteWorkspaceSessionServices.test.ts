import { describe, expect, it, vi } from "vitest";
import type { IServiceAccessor, IUsageStatsService, ProviderSettingsView } from "@zcode/services";
import type { AppUsageSnapshot } from "@zcode/shared";
import { createUsageStatsService } from "@zcode/services/node";
import { buildRemoteWorkspaceSessionServices } from "../src/renderer/src/remoteWorkspaceSessionServices.js";

function agent(generatedAt: number) {
  const snapshot = { source: "agent-db", generatedAt } as AppUsageSnapshot;
  return { snapshot, getAppUsageStats: vi.fn(async () => snapshot) };
}

function accessor(
  usageStatsService: IUsageStatsService,
  zcodeAgentService: ReturnType<typeof agent>,
): IServiceAccessor {
  // 合并契约只依赖这些服务；其余能力由既有 accessor 提供，与本回归无关。
  return { usageStatsService, zcodeAgentService } as unknown as IServiceAccessor;
}

function localHost() {
  const zcodeAgentService = agent(1);
  const getView = vi.fn(
    async () =>
      ({
        revision: 1,
        providerTemplates: [],
        providerOrder: ["local-provider"],
        providers: [
          {
            providerId: "local-provider",
            providerName: "local fixture",
            enabled: true,
            executable: true,
            issues: [],
            personalConfig: {},
            models: [],
            effectiveConfig: {
              access: { type: "zhipu-coding-plan-api-key", apiKey: "local-fixture-key" },
              api: { baseUrl: "https://open.bigmodel.cn/api/anthropic" },
            },
          },
        ],
      }) as ProviderSettingsView,
  );
  const onDidChange = vi.fn(() => ({ dispose: vi.fn() }));
  const network = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: { limits: [{ type: "TIME_LIMIT", remaining: 7 }] },
        }),
      ),
  );
  const usageStatsService = createUsageStatsService({
    zcodeAgentService,
    apiClient: { request: network },
    providerSettingsService: { getView, onDidChange },
  });
  return {
    services: accessor(usageStatsService, zcodeAgentService),
    usageStatsService,
    zcodeAgentService,
    getView,
    onDidChange,
    network,
  };
}

function remoteHost(generatedAt = 2) {
  const zcodeAgentService = agent(generatedAt);
  // 与 remote workspace Host 一致：额度依赖缺席，只有目标 Agent 的使用统计能力。
  const usageStatsService = createUsageStatsService({ zcodeAgentService });
  return {
    services: accessor(usageStatsService, zcodeAgentService),
    usageStatsService,
    zcodeAgentService,
  };
}

describe("Desktop remote workspace usage service boundary", () => {
  it("changes the usage service identity on local → remote → another remote without mutating base", () => {
    const local = localHost();
    const first = remoteHost();
    const second = remoteHost(3);
    const mergedFirst = buildRemoteWorkspaceSessionServices(local.services, first.services);
    const mergedSecond = buildRemoteWorkspaceSessionServices(local.services, second.services);
    expect(mergedFirst.usageStatsService).toBe(first.usageStatsService);
    expect(mergedFirst.usageStatsService).not.toBe(local.usageStatsService);
    expect(mergedSecond.usageStatsService).toBe(second.usageStatsService);
    expect(mergedSecond.usageStatsService).not.toBe(mergedFirst.usageStatsService);
    expect(local.services.usageStatsService).toBe(local.usageStatsService);
  });

  it("routes quota context, query and subscription to remote fail-closed service, never local Key/API", async () => {
    const local = localHost();
    const remote = remoteHost();
    const localContext = await local.usageStatsService.getCodingPlanQuotaContext();
    expect(localContext.status).toBe("available");
    if (localContext.status !== "available") throw new Error("fixture unavailable");
    local.getView.mockClear();
    const contextCalls = vi.spyOn(remote.usageStatsService, "getCodingPlanQuotaContext");
    const quotaCalls = vi.spyOn(remote.usageStatsService, "getCodingPlanQuota");
    const eventCalls = vi.spyOn(remote.usageStatsService, "onDidChangeCodingPlanQuotaContext");
    const merged = buildRemoteWorkspaceSessionServices(local.services, remote.services);
    await expect(merged.usageStatsService.getCodingPlanQuotaContext()).rejects.toThrow(
      "quota-unavailable",
    );
    await expect(
      merged.usageStatsService.getCodingPlanQuota({ contextId: localContext.contextId }),
    ).rejects.toThrow("quota-unavailable");
    const listener = vi.fn();
    const subscription = merged.usageStatsService.onDidChangeCodingPlanQuotaContext(listener);
    subscription.dispose();
    expect(contextCalls).toHaveBeenCalledOnce();
    expect(quotaCalls).toHaveBeenCalledWith({ contextId: localContext.contextId });
    expect(eventCalls).toHaveBeenCalledWith(listener);
    expect(listener).not.toHaveBeenCalled();
    expect(local.getView).not.toHaveBeenCalled();
    expect(local.onDidChange).not.toHaveBeenCalled();
    expect(local.network).not.toHaveBeenCalled();
  });

  it("keeps ordinary local and remote usage snapshots bound to their own target Agent", async () => {
    const local = localHost();
    const remote = remoteHost();
    const request = { range: "7d" as const, timeZone: "UTC" };
    expect(await local.services.usageStatsService.getAppUsageSnapshot(request)).toBe(
      local.zcodeAgentService.snapshot,
    );
    const merged = buildRemoteWorkspaceSessionServices(local.services, remote.services);
    expect(await merged.usageStatsService.getAppUsageSnapshot(request)).toBe(
      remote.zcodeAgentService.snapshot,
    );
    expect(remote.zcodeAgentService.getAppUsageStats).toHaveBeenCalledExactlyOnceWith(request);
    expect(local.zcodeAgentService.getAppUsageStats).toHaveBeenCalledExactlyOnceWith(request);
    expect(merged.zcodeAgentService).toBe(remote.zcodeAgentService);
    expect(local.getView).not.toHaveBeenCalled();
    expect(local.network).not.toHaveBeenCalled();
  });
});
