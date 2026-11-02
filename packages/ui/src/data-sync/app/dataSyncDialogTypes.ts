import type { DataSyncCategoryId } from "@/data-sync/contract.js";
import type { DataSyncRow } from "@/data-sync/domain/compare.js";

export type DataSyncPushState = "idle" | "pushing" | "done" | "failed";

export interface DataSyncItemError {
  status: "failed" | "conflict";
  message?: string;
}

export interface DataSyncCategoryView {
  id: DataSyncCategoryId;
  phase: "loading" | "ready" | "error";
  error?: string;
  rows: DataSyncRow[];
  localCount: number;
  remoteCount: number;
  /** 最近一次加载的两端条目 key（含各端独有项），供其他分类的依赖提示使用；只在 phase 为 ready 时有效。 */
  sourceKeys: ReadonlySet<string>;
  targetKeys: ReadonlySet<string>;
  selected: ReadonlySet<string>;
  push: DataSyncPushState;
  /** 分类整体失败（预检、RPC、断线）的原因；`offline` 表示推送中设备断开。 */
  pushError?: string;
  itemErrors: Readonly<Record<string, DataSyncItemError>>;
  failedCount: number;
  /** 推送中当前可「停止」的项（marketplace 插件的远端 add / install 阶段）。 */
  stoppable: ReadonlySet<string>;
}

export type DataSyncPushAllState = "idle" | "pushing" | "done";

export interface PushOutcome {
  succeeded: number;
  failed: number;
}

/** 一次推送（单个分类或推送全部）。断线时被作废，迟到结果按 session 身份丢弃。 */
export interface PushSession {
  kind: "category" | "all";
  outcomes: PushOutcome[];
  activeCategory?: DataSyncCategoryId;
}

export type HashCache = Map<string, { signature: string; hash: string }>;
