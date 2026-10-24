import { randomUUID } from "node:crypto";
import type { ApiClient, AppUsageRequest, AppUsageSnapshot } from "@zcode/shared";
import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import type {
  IProviderSettingsService,
  ProviderSettingsView,
} from "../model-provider/providerFacadeServices.js";
import { fetchCodingPlanQuota, resolveCodingPlanQuotaUrl } from "./codingPlanQuota.js";
import type { CodingPlanQuotaContext, IUsageStatsService } from "./usageStats.js";

interface UsageStatsServiceDependencies {
  zcodeAgentService: Pick<IZCodeAgentService, "getAppUsageStats">;
  apiClient?: ApiClient;
  providerSettingsService?: Pick<IProviderSettingsService, "getView" | "onDidChange">;
}
interface QuotaCredential {
  readonly providerId: string;
  readonly providerName: string;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly family: "bigmodel" | "zai";
}

function selectCredential(view: ProviderSettingsView): {
  credential: QuotaCredential | null;
  reason: "no-provider" | "missing-api-key" | "unsupported-provider";
} {
  let reason: "no-provider" | "missing-api-key" | "unsupported-provider" = "no-provider";
  for (const provider of view.providers) {
    const access = provider.effectiveConfig.access;
    if (
      !provider.enabled ||
      !provider.personalConfig ||
      access?.type !== "zhipu-coding-plan-api-key"
    )
      continue;
    const baseUrl = provider.effectiveConfig.api?.baseUrl?.trim() ?? "";
    const target = resolveCodingPlanQuotaUrl(baseUrl);
    const headers = provider.effectiveConfig.api?.headers;
    // Team 的组织/项目头不能混进个人 Key 查询；不转发任何用户自定义头。
    const team = Object.keys(headers ?? {}).some((name) => /org|project/i.test(name));
    if (!target || team) {
      reason = "unsupported-provider";
      continue;
    }
    const apiKey = access.apiKey?.trim() ?? "";
    if (!apiKey) {
      reason = "missing-api-key";
      continue;
    }
    return {
      credential: {
        providerId: provider.providerId,
        providerName: provider.providerName ?? provider.providerId,
        apiKey,
        baseUrl,
        family: target.family,
      },
      reason,
    };
  }
  return { credential: null, reason };
}

export function createUsageStatsService(
  dependencies: UsageStatsServiceDependencies,
): IUsageStatsService {
  let credential: QuotaCredential | null = null;
  let context: CodingPlanQuotaContext = { status: "unavailable", reason: "no-provider" };
  let revision = -1;
  const listeners = new Set<(value: CodingPlanQuotaContext) => void>();
  let subscription: { dispose(): void } | null = null;
  const applyView = (view: ProviderSettingsView): void => {
    // getView 与 onDidChange 可以交错；旧 View 不得重新签发旧 Key 的上下文。
    if (view.revision < revision) return;
    revision = view.revision;
    const selected = selectCredential(view);
    const next = selected.credential;
    const sameCredential =
      next !== null &&
      credential !== null &&
      next.providerId === credential.providerId &&
      next.apiKey === credential.apiKey &&
      next.baseUrl === credential.baseUrl;
    const nextContext: CodingPlanQuotaContext = next
      ? {
          status: "available",
          contextId:
            sameCredential && context.status === "available" ? context.contextId : randomUUID(),
          providerId: next.providerId,
          providerName: next.providerName,
          family: next.family,
        }
      : { status: "unavailable", reason: selected.reason };
    credential = next;
    const changed = JSON.stringify(nextContext) !== JSON.stringify(context);
    context = nextContext;
    if (changed) for (const listener of listeners) listener(context);
  };
  const readContext = async (): Promise<CodingPlanQuotaContext> => {
    if (!dependencies.providerSettingsService || !dependencies.apiClient)
      throw new Error("quota-unavailable");
    let view: ProviderSettingsView;
    try {
      view = await dependencies.providerSettingsService.getView();
    } catch {
      throw new Error("quota-unavailable");
    }
    applyView(view);
    return context;
  };
  return {
    async getAppUsageSnapshot(request: AppUsageRequest): Promise<AppUsageSnapshot> {
      return dependencies.zcodeAgentService.getAppUsageStats({
        range: request.range,
        timeZone: request.timeZone,
      });
    },
    onDidChangeCodingPlanQuotaContext(listener) {
      listeners.add(listener);
      if (!subscription && dependencies.providerSettingsService) {
        subscription = dependencies.providerSettingsService.onDidChange(applyView);
      }
      return {
        dispose() {
          listeners.delete(listener);
          if (listeners.size === 0) {
            subscription?.dispose();
            subscription = null;
          }
        },
      };
    },
    getCodingPlanQuotaContext: readContext,
    async getCodingPlanQuota(request) {
      await readContext();
      // await 返回前也可能收到换 Key 事件；校验当前 owner，不能借旧 context 使用新凭据。
      if (
        context.status !== "available" ||
        context.contextId !== request.contextId ||
        !credential ||
        !dependencies.apiClient
      ) {
        throw new Error("quota-context-changed");
      }
      const result = await fetchCodingPlanQuota({
        apiClient: dependencies.apiClient,
        baseUrl: credential.baseUrl,
        apiKey: credential.apiKey,
      });
      // 网络期间换 Key/删连接时，旧响应必须拒绝；不能保留为新连接的上一次成功快照。
      await readContext();
      if (context.status !== "available" || context.contextId !== request.contextId)
        throw new Error("quota-context-changed");
      if (!result.success) throw new Error(`quota-${result.error.code}`);
      return result.snapshot;
    },
  };
}
