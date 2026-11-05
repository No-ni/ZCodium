import type { SitesFailureReason, SitesResult } from "../contract.ts";

/**
 * 只保留历史 stdio 消息的身份 key；本仓 shared 已删除官方身份接口，
 * 不能为历史插件测试恢复它。没有合格身份或显式自建 endpoint 均不发请求。
 */
export const OFFICIAL_MCP_AUTH_META_KEY = "com.zcode/official-mcp-auth";

const AUTH_REASONS = new Set<SitesFailureReason>([
  "official_auth_unavailable",
  "official_auth_plan_required",
  "official_mcp_origin_untrusted",
]);

type AuthResult =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; reason: SitesFailureReason };

/** 读出身份头；缺失或形状不对都按「官方鉴权不可用」处理，不匿名请求。 */
export function readOfficialAuth(meta: unknown): AuthResult {
  const value = isRecord(meta) ? meta[OFFICIAL_MCP_AUTH_META_KEY] : undefined;
  if (!isRecord(value)) return { ok: false, reason: "official_auth_unavailable" };
  if (value.ok === true && isRecord(value.headers)) {
    const headers: Record<string, string> = {};
    for (const [name, header] of Object.entries(value.headers))
      if (typeof header === "string") headers[name] = header;
    if (Object.keys(headers).length) return { ok: true, headers };
  }
  const reason = value.reason as SitesFailureReason;
  return { ok: false, reason: AUTH_REASONS.has(reason) ? reason : "official_auth_unavailable" };
}

export interface SitesApiOptions {
  /** 显式自建 endpoint；缺失时拒绝，不回退官方地址。 */
  origin: string | undefined;
  /** 控制面要求的 X-ZCode-App-Version；缺失返回 3001，过旧返回 3609。 */
  appVersion: string;
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
}

export type SitesApi = (
  authMeta: unknown,
  method: "GET" | "PATCH",
  path: string,
  body?: Record<string, unknown>,
) => Promise<SitesResult>;

/**
 * 每次请求现取身份头，不缓存、不落盘、不写日志。401 不重试：宿主下一条消息会带上刷新后的头。
 * redirect 设为 manual，3xx 按坏响应处理，避免身份头被带到别的 origin。
 */
export function createSitesApi(options: SitesApiOptions): SitesApi {
  return async (authMeta, method, path, body) => {
    // fork 已移除官方默认 origin；不能把 undefined 拼成 URL 再尝试网络请求。
    if (!options.origin?.trim()) return { error: { reason: "official_mcp_origin_untrusted" } };
    const auth = readOfficialAuth(authMeta);
    if (!auth.ok) return { error: { reason: auth.reason } };
    let response: Response;
    try {
      response = await options.fetch(options.origin + path, {
        method,
        headers: {
          ...auth.headers,
          Accept: "application/json",
          "X-ZCode-App-Version": options.appVersion,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch {
      return { error: { reason: "network" } };
    }
    if (response.status === 401) return { error: { reason: "unauthenticated" } };
    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch {
      return { error: { reason: "bad_response" } };
    }
    if (!isRecord(envelope) || typeof envelope.code !== "number")
      return { error: { reason: "bad_response" } };
    const logid = typeof envelope.logid === "string" && envelope.logid ? envelope.logid : undefined;
    if (envelope.code !== 0) return { error: { code: envelope.code, ...(logid ? { logid } : {}) } };
    return { data: envelope.data };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
