import type { DataSyncImportItem, DataSyncListItem, DataSyncWorkspaceMapping } from "@zcode/shared";
import type { DataSyncCategoryId } from "@/data-sync/contract.js";
import type { DataSyncRow } from "@/data-sync/domain/compare.js";
import type { DataSyncCategoryView, HashCache } from "./dataSyncDialogTypes.js";

/** 写权限预检超时，与旧同步弹窗一致。 */
export const DATA_SYNC_PREFLIGHT_TIMEOUT_MS = 15_000;

export class StalePushError extends Error {}

export const DATA_SYNC_OFFLINE_ERROR = "offline";
export const DATA_SYNC_PREFLIGHT_TIMEOUT_ERROR = "preflight-timeout";

export function createInitialView(id: DataSyncCategoryId): DataSyncCategoryView {
  return {
    id,
    phase: "loading",
    rows: [],
    localCount: 0,
    remoteCount: 0,
    sourceKeys: new Set(),
    targetKeys: new Set(),
    selected: new Set(),
    push: "idle",
    itemErrors: {},
    failedCount: 0,
    stoppable: new Set(),
  };
}

function signatureOf(item: DataSyncListItem): string {
  return item.signature ? `${item.signature.fileCount}:${item.signature.totalBytes}` : "";
}

/**
 * 弹窗内缓存（性能措施 5）：签名不变的项复用上次的哈希；推送涉及的目标项在推送后失效。
 * 没有签名的条目（JSON 类，例如 MCP）哈希很便宜，不进缓存：否则签名恒为空，本机编辑后仍会命中旧哈希。
 * 返回缓存命中的哈希和仍需向服务请求的 key。
 */
export function readHashCache(
  cache: HashCache,
  items: readonly DataSyncListItem[],
  keys: readonly string[],
): { hashes: Record<string, string>; missing: string[] } {
  const signatureByKey = new Map(items.map((item) => [item.key, signatureOf(item)]));
  const hashes: Record<string, string> = {};
  const missing: string[] = [];
  for (const key of keys) {
    const signature = signatureByKey.get(key);
    const cached = signature ? cache.get(key) : undefined;
    if (cached && cached.signature === signature) hashes[key] = cached.hash;
    else missing.push(key);
  }
  return { hashes, missing };
}

export function writeHashCache(
  cache: HashCache,
  items: readonly DataSyncListItem[],
  hashes: Readonly<Record<string, string>>,
): void {
  const signatureByKey = new Map(items.map((item) => [item.key, signatureOf(item)]));
  for (const [key, hash] of Object.entries(hashes)) {
    const signature = signatureByKey.get(key);
    if (signature) cache.set(key, { signature, hash });
  }
}

export function toImportItem(row: DataSyncRow): DataSyncImportItem {
  return {
    key: row.key,
    mode: row.importMode ?? "createOnly",
    ...(row.expectedTargetHash ? { expectedTargetHash: row.expectedTargetHash } : {}),
  };
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(DATA_SYNC_PREFLIGHT_TIMEOUT_ERROR)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function workspaceParam(workspace: DataSyncWorkspaceMapping | undefined): {
  workspace?: DataSyncWorkspaceMapping;
} {
  return workspace ? { workspace } : {};
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
