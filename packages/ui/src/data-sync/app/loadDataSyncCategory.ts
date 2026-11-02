import type { RefObject } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { DataSyncWorkspaceMapping } from "@zcode/shared";
import { logger } from "@/logger.js";
import type { DataSyncCategoryAdapter } from "@/data-sync/app/categories.js";
import type { DataSyncCategoryId } from "@/data-sync/contract.js";
import { compareDataSyncItems, selectDataSyncHashRequests } from "@/data-sync/domain/compare.js";
import {
  errorMessage,
  readHashCache,
  workspaceParam,
  writeHashCache,
} from "./dataSyncDialogHelpers.js";
import type { DataSyncCategoryView, HashCache } from "./dataSyncDialogTypes.js";

interface LoadDataSyncCategoryContext {
  generationRef: RefObject<number>;
  connectionRef: RefObject<IServiceAccessor | undefined>;
  sourceServices: IServiceAccessor | undefined;
  updateView: (
    id: DataSyncCategoryId,
    update: (view: DataSyncCategoryView) => DataSyncCategoryView,
  ) => void;
  sourceCacheRef: RefObject<Map<DataSyncCategoryId, HashCache>>;
  targetCacheRef: RefObject<Map<DataSyncCategoryId, HashCache>>;
  latestParamsRef: RefObject<{ workspace?: DataSyncWorkspaceMapping }>;
}

export function cacheFor(store: Map<DataSyncCategoryId, HashCache>, id: DataSyncCategoryId) {
  let cache = store.get(id);
  if (!cache) {
    cache = new Map();
    store.set(id, cache);
  }
  return cache;
}

export async function loadDataSyncCategory(
  context: LoadDataSyncCategoryContext,
  category: DataSyncCategoryAdapter,
  mode: "initial" | "refresh",
) {
  const generation = context.generationRef.current;
  const target = context.connectionRef.current;
  if (!context.sourceServices || !target) return;
  const sourceService = category.getService(context.sourceServices);
  const targetService = category.getService(target);
  if (mode === "initial") {
    context.updateView(category.id, (view) => ({ ...view, phase: "loading", error: undefined }));
  }
  try {
    // 两端并行（性能措施 4）；概览按分类逐行显示加载状态。
    const [sourceList, targetList] = await Promise.all([
      sourceService.listSyncItems(),
      targetService.listSyncItems(),
    ]);
    if (generation !== context.generationRef.current) return;
    const requests = selectDataSyncHashRequests(
      sourceList.items,
      targetList.items,
      targetList.importBlockedReason,
    );
    const sourceCache = cacheFor(context.sourceCacheRef.current, category.id);
    const targetCache = cacheFor(context.targetCacheRef.current, category.id);
    const sourceCached = readHashCache(sourceCache, sourceList.items, requests.sourceKeys);
    const targetCached = readHashCache(targetCache, targetList.items, requests.targetKeys);
    const [sourceHashes, targetHashes] = await Promise.all([
      sourceCached.missing.length > 0
        ? // 来源端带上目标端 home：需要路径改写的分类（MCP）按目标端路径计算后再比较。
          sourceService.getSyncContentHashes({
            keys: sourceCached.missing,
            targetHomeDir: targetList.homeDir,
            ...workspaceParam(context.latestParamsRef.current.workspace),
          })
        : Promise.resolve({ hashes: {} }),
      targetCached.missing.length > 0
        ? targetService.getSyncContentHashes({ keys: targetCached.missing })
        : Promise.resolve({ hashes: {} }),
    ]);
    if (generation !== context.generationRef.current) return;
    writeHashCache(sourceCache, sourceList.items, sourceHashes.hashes);
    writeHashCache(targetCache, targetList.items, targetHashes.hashes);
    const rows = compareDataSyncItems({
      sourceItems: sourceList.items,
      targetItems: targetList.items,
      sourceHashes: { ...sourceCached.hashes, ...sourceHashes.hashes },
      targetHashes: { ...targetCached.hashes, ...targetHashes.hashes },
      targetBlockedReason: targetList.importBlockedReason,
    });
    const selectable = new Set(rows.filter((row) => row.selectable).map((row) => row.key));
    context.updateView(category.id, (view) => ({
      ...view,
      phase: "ready",
      error: undefined,
      rows,
      localCount: sourceList.items.length,
      remoteCount: targetList.items.length,
      sourceKeys: new Set(sourceList.items.map((item) => item.key)),
      targetKeys: new Set(targetList.items.map((item) => item.key)),
      // 首次加载用默认勾选；推送后刷新保留用户仍可勾选的选择（失败项留着便于「再次同步」）。
      selected:
        mode === "initial"
          ? new Set(rows.filter((row) => row.defaultSelected).map((row) => row.key))
          : new Set([...view.selected].filter((key) => selectable.has(key))),
    }));
  } catch (error) {
    if (generation !== context.generationRef.current) return;
    logger.warn("[DataSync] 加载分类失败", {
      category: category.id,
      error: errorMessage(error),
    });
    context.updateView(category.id, (view) => ({
      ...view,
      phase: "error",
      error: errorMessage(error),
    }));
  }
}
