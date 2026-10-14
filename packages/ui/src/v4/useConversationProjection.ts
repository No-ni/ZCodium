import { useSyncExternalStore } from "react";
import type { ConversationStoreState } from "@/v4/conversationProjectionStore.js";
import type { SessionDataLayer, SessionLease } from "@/v4/sessionDataLayer.js";

export interface PaneSessionProjectionBinding {
  lease: SessionLease;
  layer: SessionDataLayer;
  draftInvalidationVersion: number;
}

export function resolvePaneSessionProjectionLease(
  binding: PaneSessionProjectionBinding | null,
  layer: SessionDataLayer,
  draftInvalidationVersion?: number,
): SessionLease | null {
  // 会话 id 只在所属 Host/workspace 内唯一；effect 换租约前不能向新 pane 投影旧来源。
  // 草稿重建也必须先屏蔽旧代，否则镜像预热 id 仍能命中刚失效的 cwd 和配置。
  return binding?.layer === layer &&
    (draftInvalidationVersion === undefined ||
      binding.draftInvalidationVersion === draftInvalidationVersion)
    ? binding.lease
    : null;
}

const CLOSED_STATE: ConversationStoreState = {
  status: "closed",
  snapshot: null,
  subscriptionId: null,
  lastError: null,
  optimisticCommands: [],
  loadingOlder: false,
  sessionPlans: [],
  planDirectoryRevision: 0,
  plansLoading: false,
  turnNavigatorDirectoryRevision: 0,
};

/** 订阅 per-session projection store（useSyncExternalStore，row 级 selector 在组件内再做）。 */
export function useConversationProjection(lease: SessionLease | null): ConversationStoreState {
  const store = lease?.store ?? null;
  return useSyncExternalStore(
    (listener) => store?.subscribe(listener) ?? (() => {}),
    () => store?.getState() ?? CLOSED_STATE,
    () => CLOSED_STATE,
  );
}
