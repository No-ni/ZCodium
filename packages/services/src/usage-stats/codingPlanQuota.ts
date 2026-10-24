import { z } from "zod";
import type { ApiClient, UsageQuotaLimit } from "@zcode/shared";
import type { CodingPlanQuotaSnapshot } from "./usageStats.js";

const QUOTA_PATH = "/api/monitor/usage/quota/limit";
const nonNegative = z.number().finite().nonnegative();
const limitSchema = z.object({
  type: z.string().trim().min(1),
  unit: nonNegative.optional(),
  number: nonNegative.optional(),
  usage: nonNegative.optional(),
  currentValue: nonNegative.optional(),
  remaining: nonNegative.optional(),
  percentage: nonNegative.max(100).optional(),
  nextResetTime: nonNegative.max(8_640_000_000_000_000).optional(),
  usageDetails: z
    .array(
      z.object({
        modelCode: z.string(),
        displayName: z.string().optional(),
        usage: nonNegative.default(0),
      }),
    )
    .default([]),
});
const envelopeSchema = z.object({
  success: z.boolean().optional(),
  code: z.number().optional(),
  data: z
    .object({
      level: z.string().nullable().optional(),
      limits: z.array(limitSchema).default([]),
    })
    .nullable()
    .optional(),
});

export type CodingPlanQuotaErrorCode =
  | "missing-api-key"
  | "unsupported-provider"
  | "request-failed"
  | "invalid-response";
export type CodingPlanQuotaResult =
  | { readonly success: true; readonly snapshot: CodingPlanQuotaSnapshot }
  | { readonly success: false; readonly error: { readonly code: CodingPlanQuotaErrorCode } };

/** 不复用可配置业务域：未知代理、userinfo 和重定向都不能拿到个人 Key。 */
export function resolveCodingPlanQuotaUrl(baseUrl: string): {
  family: "bigmodel" | "zai";
  url: string;
} | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port || url.username || url.password) return null;
  if (url.hostname === "api.z.ai") return { family: "zai", url: `https://api.z.ai${QUOTA_PATH}` };
  if (url.hostname === "open.bigmodel.cn" || url.hostname === "bigmodel.cn") {
    return { family: "bigmodel", url: `https://bigmodel.cn${QUOTA_PATH}` };
  }
  return null;
}

/** 这里没有缓存，也不传递异常/业务 msg；厂商响应可能回显凭据。 */
export async function fetchCodingPlanQuota(options: {
  readonly apiClient: ApiClient;
  readonly baseUrl: string;
  readonly apiKey: string;
}): Promise<CodingPlanQuotaResult> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) return { success: false, error: { code: "missing-api-key" } };
  const target = resolveCodingPlanQuotaUrl(options.baseUrl);
  if (!target) return { success: false, error: { code: "unsupported-provider" } };
  let body: unknown;
  try {
    const response = await options.apiClient.request(target.url, {
      method: "GET",
      headers: { authorization: apiKey },
      redirect: "error",
      timeoutMs: 15_000,
    });
    if (!response.ok) return { success: false, error: { code: "request-failed" } };
    body = await response.json();
  } catch {
    return { success: false, error: { code: "request-failed" } };
  }
  const parsed = envelopeSchema.safeParse(body);
  if (
    !parsed.success ||
    parsed.data.success === false ||
    (parsed.data.code !== undefined && ![0, 200].includes(parsed.data.code))
  ) {
    return { success: false, error: { code: "invalid-response" } };
  }
  // monitor 的 percentage 是 0..100 的已使用占比；上游当成 0..1 会把 70% 误报为耗尽。
  const limits: UsageQuotaLimit[] = (parsed.data.data?.limits ?? []).map((limit) => ({
    ...limit,
    ...(limit.percentage === undefined ? {} : { percentage: limit.percentage / 100 }),
  }));
  const remaining =
    limits.find((limit) => limit.type === "TIME_LIMIT") ??
    limits.find((limit) => limit.remaining !== undefined) ??
    limits[0] ??
    null;
  return {
    success: true,
    snapshot: {
      fetchedAt: Date.now(),
      family: target.family,
      level: parsed.data.data?.level?.trim() || null,
      limits,
      remaining,
    },
  };
}
