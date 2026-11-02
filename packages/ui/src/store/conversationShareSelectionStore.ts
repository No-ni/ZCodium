import { createConversationSharePopoverActions } from "@/conversation-share-interaction/conversationSharePopoverActions.js";
import { create } from "zustand";
import type { ConversationShareRejection } from "@zcode/shared";
import type { ConversationShareFailureIssue } from "@zcode/services";

export interface ConversationShareAttempt {
  key: string;
  clientRequestId: string;
}

export interface ConversationShareDisplayError {
  issues: readonly ConversationShareFailureIssue[];
  issueCount: number;
  omittedIssueCount?: number;
  requestId?: string;
  clientRequestId?: string;
  operationId?: string;
  status?: number;
  code?: number;
  rejection?: ConversationShareRejection;
  /** 没有服务端 issues 时展示的、按错误类型解析出的可行动文案。 */
  messageId?: string;
}

/** 发布成功但有结果物被跳过时的非阻断提示。 */
export interface ConversationShareDisplayWarnings {
  issues: readonly ConversationShareFailureIssue[];
  issueCount: number;
  omittedIssueCount?: number;
}

export type ConversationShareProgressPhase = "collecting" | "packing" | "saving";

export interface ConversationShareSelectionDraft {
  open?: boolean;
  pendingExcludedRowIds?: readonly number[] | null;
  availableRowIds: readonly number[];
  excludedRowIds: readonly number[];
  productTurnIdByRowId: Readonly<Record<number, string>>;
}

export interface ConversationShareDockState {
  title?: string;
  publishing: boolean;
  progress: ConversationShareProgressPhase;
  completedArtifacts: number;
  totalArtifacts: number;
  exportedFile: { name: string; downloadStarted: boolean } | null;
  error: ConversationShareDisplayError | null;
  warnings: ConversationShareDisplayWarnings | null;
  attempt: ConversationShareAttempt | null;
}

export interface ConversationShareSelectionState {
  openShare: (taskId: string) => void;
  closeShare: (taskId: string) => void;
  beginSelectionEdit: (taskId: string) => void;
  togglePendingRow: (taskId: string, rowId: number) => void;
  setAllPendingRowsSelected: (taskId: string, selected: boolean) => void;
  confirmSelectionEdit: (taskId: string) => void;
  cancelSelectionEdit: (taskId: string) => void;
  drafts: Record<string, ConversationShareSelectionDraft>;
  dockStates: Record<string, ConversationShareDockState>;
  syncAvailableTurns: (
    taskId: string,
    turns: readonly { rowId: number; productTurnId: string }[],
  ) => void;
  /** 按 product turn 身份整轮取消选择（阻断项的「取消选择该轮」入口）。 */
  deselectProductTurn: (taskId: string, productTurnId: string) => void;
  updateDockState: (taskId: string, patch: Partial<ConversationShareDockState>) => void;
  resetForTests: () => void;
}

const EMPTY_DRAFT: ConversationShareSelectionDraft = Object.freeze({
  availableRowIds: Object.freeze([]),
  excludedRowIds: Object.freeze([]),
  productTurnIdByRowId: Object.freeze({}),
});

export const DEFAULT_CONVERSATION_SHARE_DOCK_STATE: ConversationShareDockState = Object.freeze({
  publishing: false,
  progress: "collecting",
  completedArtifacts: 0,
  totalArtifacts: 0,
  exportedFile: null,
  error: null,
  warnings: null,
  attempt: null,
});

function normalizeRowIds(rowIds: readonly number[]): number[] {
  return [...new Set(rowIds.filter(Number.isSafeInteger))].sort((left, right) => left - right);
}

export function getConversationShareDraft(
  state: Pick<ConversationShareSelectionState, "drafts">,
  taskId: string,
): ConversationShareSelectionDraft {
  return state.drafts[taskId] ?? EMPTY_DRAFT;
}

export function getConversationShareDockState(
  state: Pick<ConversationShareSelectionState, "dockStates">,
  taskId: string,
): ConversationShareDockState {
  return state.dockStates[taskId] ?? DEFAULT_CONVERSATION_SHARE_DOCK_STATE;
}

export function getConversationShareSelectedRowIds(
  state: Pick<ConversationShareSelectionState, "drafts">,
  taskId: string,
  source: "confirmed" | "pending" = "confirmed",
): number[] {
  const draft = getConversationShareDraft(state, taskId);
  const excluded = new Set(
    source === "pending"
      ? (draft.pendingExcludedRowIds ?? draft.excludedRowIds)
      : draft.excludedRowIds,
  );
  return draft.availableRowIds.filter((rowId) => !excluded.has(rowId));
}

export function getConversationShareSelectedProductTurnIds(
  state: Pick<ConversationShareSelectionState, "drafts">,
  taskId: string,
  source: "confirmed" | "pending" = "confirmed",
): string[] {
  const draft = getConversationShareDraft(state, taskId);
  const seen = new Set<string>();
  const excluded = new Set(
    source === "pending"
      ? (draft.pendingExcludedRowIds ?? draft.excludedRowIds)
      : draft.excludedRowIds,
  );
  return draft.availableRowIds
    .filter((rowId) => !excluded.has(rowId))
    .flatMap((rowId) => {
      const productTurnId = draft.productTurnIdByRowId[rowId];
      if (!productTurnId || seen.has(productTurnId)) return [];
      seen.add(productTurnId);
      return [productTurnId];
    });
}

export const useConversationShareSelectionStore = create<ConversationShareSelectionState>()(
  (set) => ({
    ...createConversationSharePopoverActions(
      set,
      getConversationShareDraft,
      getConversationShareDockState,
      DEFAULT_CONVERSATION_SHARE_DOCK_STATE,
    ),
    drafts: {},
    dockStates: {},
    syncAvailableTurns: (taskId, turns) =>
      set((state) => {
        const current = getConversationShareDraft(state, taskId);
        if (!current.open) return state;
        const productTurnIdByRowId = Object.fromEntries(
          turns.map((turn) => [turn.rowId, turn.productTurnId]),
        );
        const availableRowIds = normalizeRowIds(turns.map((turn) => turn.rowId));
        const available = new Set(availableRowIds);
        const nextDraft = {
          ...current,
          availableRowIds,
          excludedRowIds: current.excludedRowIds.filter((rowId) => available.has(rowId)),
          productTurnIdByRowId,
        };
        // 披露确认由 ConfirmationDock 本地拥有并按 key 重挂载重置，selection store 不再写第二份披露字段。
        return {
          drafts: { ...state.drafts, [taskId]: nextDraft },
        };
      }),
    updateDockState: (taskId, patch) =>
      set((state) => ({
        dockStates: {
          ...state.dockStates,
          [taskId]: {
            ...getConversationShareDockState(state, taskId),
            ...patch,
          },
        },
      })),
    resetForTests: () =>
      set({
        drafts: {},
        dockStates: {},
      }),
  }),
);
