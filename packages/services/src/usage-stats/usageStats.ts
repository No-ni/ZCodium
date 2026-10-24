import type { Event } from "@zcode/rpc";
import type { AppUsageRequest, AppUsageSnapshot, UsageQuotaLimit } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export type CodingPlanQuotaContext =
  | {
      readonly status: "available";
      /** Host 签发的不透明代际，不包含 Key 或 Key 的可关联摘要。 */
      readonly contextId: string;
      readonly providerId: string;
      readonly providerName: string;
      readonly family: "bigmodel" | "zai";
    }
  | {
      readonly status: "unavailable";
      readonly reason: "no-provider" | "missing-api-key" | "unsupported-provider";
    };

export interface CodingPlanQuotaSnapshot {
  readonly fetchedAt: number;
  readonly family: "bigmodel" | "zai";
  readonly level: string | null;
  readonly limits: UsageQuotaLimit[];
  readonly remaining: UsageQuotaLimit | null;
}

export interface IUsageStatsService {
  getAppUsageSnapshot(request: AppUsageRequest): Promise<AppUsageSnapshot>;
  readonly onDidChangeCodingPlanQuotaContext: Event<CodingPlanQuotaContext>;
  getCodingPlanQuotaContext(): Promise<CodingPlanQuotaContext>;
  /** 凭据由所属 Host 读取；Renderer 只提交脱敏上下文代际。 */
  getCodingPlanQuota(request: { readonly contextId: string }): Promise<CodingPlanQuotaSnapshot>;
}

export const IUsageStatsService = createServiceDescriptor<IUsageStatsService>(
  ServiceChannels.UsageStats,
);
