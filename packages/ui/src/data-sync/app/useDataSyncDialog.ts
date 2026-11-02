import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type {
  DataSyncImportResultItem,
  DataSyncWorkspaceMapping,
  DeviceSyncResult,
  SourceServerWorkspaceHistoryEntry,
} from "@zcode/shared";
import { logger } from "@/logger.js";
import type {
  DataSyncAfterPushContext,
  DataSyncCategoryAdapter,
} from "@/data-sync/app/categories.js";
import type { DataSyncCategoryId } from "@/data-sync/contract.js";
import type { DataSyncPushControl } from "@/data-sync/app/marketplacePluginSync.js";
import { aggregateDeviceSyncResult, chunkDataSyncRows } from "@/data-sync/domain/compare.js";
import {
  DATA_SYNC_OFFLINE_ERROR,
  DATA_SYNC_PREFLIGHT_TIMEOUT_MS,
  StalePushError,
  createInitialView,
  errorMessage,
  toImportItem,
  withTimeout,
  workspaceParam,
} from "./dataSyncDialogHelpers.js";
import type {
  DataSyncCategoryView,
  DataSyncItemError,
  DataSyncPushAllState,
  HashCache,
  PushOutcome,
  PushSession,
} from "./dataSyncDialogTypes.js";
import { cacheFor, loadDataSyncCategory } from "./loadDataSyncCategory.js";

export {
  DATA_SYNC_OFFLINE_ERROR,
  DATA_SYNC_PREFLIGHT_TIMEOUT_ERROR,
  DATA_SYNC_PREFLIGHT_TIMEOUT_MS,
} from "./dataSyncDialogHelpers.js";
export type {
  DataSyncCategoryView,
  DataSyncItemError,
  DataSyncPushAllState,
  DataSyncPushState,
} from "./dataSyncDialogTypes.js";

/**
 * 数据同步弹窗状态 owner。
 *
 * generation：弹窗绑定设备的一次连接。`online && targetServices` 换代（断线、重连、attachment 换代）
 * 时递增 generation：断线则禁用操作并把进行中的推送标为失败；重连则清空目标端哈希缓存并重新加载。
 * 所有异步结果在落盘到状态前核对 generation / push session，旧连接的迟到结果一律丢弃。
 */
export function useDataSyncDialog(params: {
  categories: readonly DataSyncCategoryAdapter[];
  sourceServerId: string;
  sourceServices: IServiceAccessor | undefined;
  targetServices: IServiceAccessor | undefined;
  online: boolean;
  workspaceHistory?: readonly SourceServerWorkspaceHistoryEntry[];
  workspaceTabs?: DataSyncAfterPushContext["workspaceTabs"];
  /** 只传给来源端（哈希与导出）；弹窗打开期间不变。 */
  workspace?: DataSyncWorkspaceMapping;
  onPushFinished(result: DeviceSyncResult): void | Promise<void>;
  /** 逐插件 sync 终态上报；可选回调。弹窗提供时按插件记录安全本地 debug 诊断（scope / remoteKind / result / durationMs），不外发；未提供（例如测试）时跳过，不改变推送结果。 */
  reportPluginSyncResult?: DataSyncPushControl["reportPluginSyncResult"];
}) {
  const { categories, sourceServices } = params;
  const connection = params.online ? params.targetServices : undefined;
  const [views, setViews] = useState<Record<string, DataSyncCategoryView>>(() =>
    Object.fromEntries(categories.map((category) => [category.id, createInitialView(category.id)])),
  );
  const [pushAllState, setPushAllState] = useState<DataSyncPushAllState>("idle");
  const viewsRef = useRef(views);
  viewsRef.current = views;
  const generationRef = useRef(0);
  const connectionRef = useRef(connection);
  const sessionRef = useRef<PushSession | null>(null);
  /** 当前推送分类中可停止项的停止回调；推送结束或作废时清空。 */
  const stoppersRef = useRef<Map<string, () => void> | null>(null);
  /** 推送后刷新的串行队列：按推送顺序执行，不属于 push session，推送不等待它。 */
  const afterPushQueueRef = useRef<Promise<void>>(Promise.resolve());
  const sourceCacheRef = useRef(new Map<DataSyncCategoryId, HashCache>());
  const targetCacheRef = useRef(new Map<DataSyncCategoryId, HashCache>());
  const latestParamsRef = useRef(params);
  latestParamsRef.current = params;

  const updateView = useCallback(
    (id: DataSyncCategoryId, update: (view: DataSyncCategoryView) => DataSyncCategoryView) => {
      setViews((current) => {
        const view = current[id];
        return view ? { ...current, [id]: update(view) } : current;
      });
    },
    [],
  );

  const loadCategory = useCallback(
    (category: DataSyncCategoryAdapter, mode: "initial" | "refresh") =>
      loadDataSyncCategory(
        {
          generationRef,
          connectionRef,
          sourceServices,
          updateView,
          sourceCacheRef,
          targetCacheRef,
          latestParamsRef,
        },
        category,
        mode,
      ),
    [sourceServices, updateView],
  );

  /**
   * 断线或换代：作废进行中的推送，当前分类标为失败，并按一次推送结束写入设备同步状态。
   * 修复：原来把断线计为当前分类 1 项失败再按条目汇总，前序分类成功时写成 partial；
   * spec 规定推送中设备断开按失败写入，这里直接写 failed。
   */
  const abandonActiveSession = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;
    stoppersRef.current = null;
    if (session.activeCategory) {
      updateView(session.activeCategory, (view) =>
        view.push === "pushing"
          ? { ...view, push: "failed", pushError: DATA_SYNC_OFFLINE_ERROR, stoppable: new Set() }
          : view,
      );
    }
    setPushAllState("idle");
    logger.info("[DataSync] 推送中设备断开，结果作废", {
      sourceServerId: latestParamsRef.current.sourceServerId,
    });
    void latestParamsRef.current.onPushFinished("failed");
  }, [updateView]);

  useEffect(() => {
    generationRef.current += 1;
    connectionRef.current = connection;
    abandonActiveSession();
    if (!connection) return;
    targetCacheRef.current.clear();
    for (const category of categories) void loadCategory(category, "initial");
  }, [abandonActiveSession, categories, connection, loadCategory]);

  const runCategoryPush = useCallback(
    async (category: DataSyncCategoryAdapter, session: PushSession): Promise<PushOutcome> => {
      // 修复原因：断线作废 session 后，推送全部的旧循环仍会在旧 RPC 结束后进入下一分类，
      // 拿新连接把该分类标为「推送中」再被 assertAlive 打断，弹窗永远停在推送中。入口先核对 session。
      if (sessionRef.current !== session) throw new StalePushError();
      const view = viewsRef.current[category.id];
      const target = connectionRef.current;
      if (!view || !sourceServices || !target) return { succeeded: 0, failed: 0 };
      const rows = view.rows.filter((row) => row.selectable && view.selected.has(row.key));
      if (rows.length === 0) return { succeeded: 0, failed: 0 };
      const stoppers = new Map<string, () => void>();
      stoppersRef.current = stoppers;
      const control: DataSyncPushControl = {
        setStoppable(key, stop) {
          if (sessionRef.current !== session || stoppersRef.current !== stoppers) return;
          if (stop) stoppers.set(key, stop);
          else stoppers.delete(key);
          const keys = new Set(stoppers.keys());
          updateView(category.id, (current) => ({ ...current, stoppable: keys }));
        },
        reportPluginSyncResult(outcome) {
          latestParamsRef.current.reportPluginSyncResult?.(outcome);
        },
      };
      const sourceService = category.getService(sourceServices);
      const targetService = category.getService(target, control);
      const assertAlive = () => {
        if (sessionRef.current !== session) throw new StalePushError();
      };
      session.activeCategory = category.id;
      updateView(category.id, (current) => ({
        ...current,
        push: "pushing",
        pushError: undefined,
        itemErrors: {},
        failedCount: 0,
      }));
      try {
        const access = await withTimeout(
          targetService.checkSyncWriteAccess(),
          DATA_SYNC_PREFLIGHT_TIMEOUT_MS,
        );
        assertAlive();
        if (!access.ok)
          throw new Error(access.error ? `${access.path}: ${access.error}` : access.path);
        const results: DataSyncImportResultItem[] = [];
        // 同一分类按批次串行导出、导入；目标端每批一次导入。父子技能同时选中时同批、上级在前。
        // 修复原因：原来所有批次共用分类外层的 catch，后一批抛错时前面批次已写入的结果被丢弃，
        // 整个分类记为全部失败，也跳过了哈希失效和推送后刷新。修法：批内异常只把该批各项记为失败，
        // 继续下一批，最后统一汇总；旧 session 的异常仍按过期外抛。
        for (const batch of chunkDataSyncRows(rows, category.maxBatchBytes, view.rows)) {
          try {
            const payload = await sourceService.exportSyncItems({
              keys: batch.map((row) => row.key),
              ...workspaceParam(latestParamsRef.current.workspace),
            });
            assertAlive();
            const imported = await targetService.importSyncItems({
              payload,
              items: batch.map(toImportItem),
            });
            assertAlive();
            results.push(...imported.results);
          } catch (error) {
            if (error instanceof StalePushError || sessionRef.current !== session) {
              throw new StalePushError();
            }
            const message = errorMessage(error);
            logger.warn("[DataSync] 批次推送失败", {
              category: category.id,
              keys: batch.map((row) => row.key),
              error: message,
            });
            for (const row of batch)
              results.push({ key: row.key, status: "failed", error: message });
          }
        }
        const resultByKey = new Map(results.map((result) => [result.key, result]));
        const itemErrors: Record<string, DataSyncItemError> = {};
        let succeeded = 0;
        for (const row of rows) {
          const result = resultByKey.get(row.key);
          if (result && result.status !== "failed" && result.status !== "conflict") {
            succeeded += 1;
          } else {
            itemErrors[row.key] = {
              status: result?.status === "conflict" ? "conflict" : "failed",
              ...(result?.error ? { message: result.error } : {}),
            };
          }
        }
        const failed = rows.length - succeeded;
        // 推送后只重算受影响的项：目标端这些 key 的哈希缓存作废（冲突项同样作废，避免反复冲突）。
        const targetCache = cacheFor(targetCacheRef.current, category.id);
        for (const row of rows) targetCache.delete(row.key);
        updateView(category.id, (current) => ({
          ...current,
          push: failed > 0 ? "failed" : "done",
          itemErrors,
          failedCount: failed,
        }));
        logger.info("[DataSync] 分类推送完成", {
          sourceServerId: latestParamsRef.current.sourceServerId,
          category: category.id,
          succeeded,
          failed,
        });
        // 修复原因：这里原来 await afterPush 后才返回，刷新一直不结束时 push session 不能收口：
        // onPushFinished 不调用（设备同步状态不写入），sessionRef 一直占用，之后的推送被入口静默忽略。
        // afterPush 只刷新运行态，不是导入成功的条件。修法：放进弹窗内的串行队列，不阻塞推送；
        // 串行是为了保持各分类刷新的先后，避免先发的刷新晚到、覆盖后一次刷新的结果。
        const context: DataSyncAfterPushContext = {
          sourceServerId: latestParamsRef.current.sourceServerId,
          targetServices: target,
          workspaceHistory: latestParamsRef.current.workspaceHistory,
          workspaceTabs: latestParamsRef.current.workspaceTabs,
        };
        afterPushQueueRef.current = afterPushQueueRef.current
          .then(() => category.afterPush?.(context))
          .catch((error: unknown) =>
            logger.warn("[DataSync] 推送后刷新失败", {
              category: category.id,
              error: errorMessage(error),
            }),
          );
        void loadCategory(category, "refresh");
        return { succeeded, failed };
      } catch (error) {
        // 修复原因：旧 session 的 RPC 在重连后才 reject 时，原来按普通失败处理，会覆盖新 session
        // 的「推送中」并放开关闭。迟到的结果一律丢弃，旧 session 的异常同样按过期处理。
        if (error instanceof StalePushError || sessionRef.current !== session) {
          throw new StalePushError();
        }
        logger.warn("[DataSync] 分类推送失败", {
          category: category.id,
          error: errorMessage(error),
        });
        updateView(category.id, (current) => ({
          ...current,
          push: "failed",
          pushError: errorMessage(error),
          failedCount: rows.length,
        }));
        return { succeeded: 0, failed: rows.length };
      } finally {
        if (stoppersRef.current === stoppers) {
          stoppersRef.current = null;
          updateView(category.id, (current) => ({ ...current, stoppable: new Set() }));
        }
      }
    },
    [loadCategory, sourceServices, updateView],
  );

  const runSession = useCallback(
    async (kind: PushSession["kind"], targets: readonly DataSyncCategoryAdapter[]) => {
      if (sessionRef.current || !connectionRef.current) return;
      const session: PushSession = { kind, outcomes: [] };
      sessionRef.current = session;
      if (kind === "all") setPushAllState("pushing");
      try {
        for (const category of targets) {
          session.outcomes.push(await runCategoryPush(category, session));
        }
      } catch (error) {
        if (error instanceof StalePushError) return;
        throw error;
      }
      if (sessionRef.current !== session) return;
      sessionRef.current = null;
      const result = aggregateDeviceSyncResult(session.outcomes);
      if (kind === "all") setPushAllState(result === "success" ? "done" : "idle");
      await latestParamsRef.current.onPushFinished(result);
    },
    [runCategoryPush],
  );

  const pushCategory = useCallback(
    (id: DataSyncCategoryId) => {
      const category = categories.find((candidate) => candidate.id === id);
      if (category) void runSession("category", [category]);
    },
    [categories, runSession],
  );

  /** 推送全部：只执行有勾选项的分类，按分类串行。 */
  const pushAll = useCallback(() => {
    const targets = categories.filter(
      (category) => (viewsRef.current[category.id]?.selected.size ?? 0) > 0,
    );
    if (targets.length > 0) void runSession("all", targets);
  }, [categories, runSession]);

  /** 按行「停止」：只作用于当前推送分类中处于远端 add / install 阶段的该项。 */
  const stopItem = useCallback((id: DataSyncCategoryId, key: string) => {
    if (sessionRef.current?.activeCategory !== id) return;
    stoppersRef.current?.get(key)?.();
  }, []);

  const setSelection = useCallback(
    (id: DataSyncCategoryId, keys: Iterable<string>) => {
      setPushAllState((state) => (state === "done" ? "idle" : state));
      updateView(id, (view) => {
        const selectable = new Set(view.rows.filter((row) => row.selectable).map((row) => row.key));
        return { ...view, selected: new Set([...keys].filter((key) => selectable.has(key))) };
      });
    },
    [updateView],
  );

  const pushing = useMemo(
    () =>
      Object.values(views).some((view) => view.push === "pushing") || pushAllState === "pushing",
    [pushAllState, views],
  );

  return {
    views,
    /** online 且 attachment 已就绪；否则禁用操作（离线提示由调用方按 online 显示）。 */
    connected: Boolean(connection),
    pushing,
    pushAllState,
    setSelection,
    pushCategory,
    pushAll,
    stopItem,
  };
}
