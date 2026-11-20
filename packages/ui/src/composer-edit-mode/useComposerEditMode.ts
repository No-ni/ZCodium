import { useCallback, useMemo, useRef, useState, type RefObject } from "react";
import type {
  CommandAck,
  ConversationRowTarget,
  ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { TID_V4_COMPOSER_EDIT_SWITCH_DIALOG } from "@zcode/shared/test-ids";
import { logger } from "@/logger.js";
import { v4QueuedCommandText } from "@/v4/slashCommands.js";
import { splitUserInputEpilogue } from "@/v4/ConversationUserInputEpilogue.js";
import type { ConversationAttachmentReadParams, ConversationTransport } from "@/v4/transport.js";
import { composerEditSessionKey } from "./contract.js";
import { ensureEditorIdentity, useEditorIdentity } from "./editorIdentity.js";
import type { ComposerEditInvalidReason, ComposerEditSession } from "./contract.js";
import { getComposerEditSession, useComposerEditStore } from "./store.js";
import {
  type DraftConfig,
  lockRequestsInFlight,
  submittedEditConfig,
  createEnterEditScope,
  useComposerEditProjection,
} from "./composerEditScope.js";

type DispatchCommand = (
  type: "lockQueueItemEdit" | "releaseQueueItemEdit",
  payload: Record<string, unknown>,
  sessionId: string,
) => Promise<CommandAck>;

export interface ComposerEditMode {
  editSession: ComposerEditSession | undefined;
  invalidReason: ComposerEditInvalidReason | null;
  editorId: string;
  pendingLockQueueItemId: string | null;
  beginUserQueryEdit: (target: ConversationRowTarget) => Promise<void>;
  beginQueueItemEdit: (queueItemId: string) => Promise<void>;
  /** 取消：释放队列锁并切回原 scope；原草稿随 scope 恢复。 */
  cancelEdit: () => void;
  /** 编辑提交成功：锁已由 editQueueItem 释放，只结束编辑态。 */
  finishEdit: () => void;
  releaseQueueItemEditLock: (queueItemId: string) => void;
  requestEditFocus: () => void;
}

export function useComposerEditMode(params: {
  sessionId: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
  remoteSessionId?: string;
  snapshot: ConversationSnapshot | null;
  snapshotRef: RefObject<ConversationSnapshot | null>;
  composerDraftStateRef: RefObject<{ hasContent: boolean; busy: boolean }>;
  composerTextRef: RefObject<string>;
  readCurrentDraftConfig: () => DraftConfig;
  /** 读回已发送附件，用于编辑态媒体卡的缩略图与预览；runtime 未就绪时缺省。 */
  readAttachment?: (
    params: ConversationAttachmentReadParams,
  ) => ReturnType<ConversationTransport["attachmentRead"]>;
  dispatchCommand: DispatchCommand;
  intl: { formatMessage: (descriptor: { id: string }) => string };
}): ComposerEditMode {
  const {
    sessionId,
    workspacePath,
    workspaceIdentity,
    workspaceKey,
    remoteSessionId,
    snapshot,
    snapshotRef,
    composerDraftStateRef,
    composerTextRef,
    readCurrentDraftConfig,
    readAttachment,
    dispatchCommand,
    intl,
  } = params;
  const { editorId, confirmed: editorIdentityConfirmed } = useEditorIdentity();
  const sessionKey = sessionId ? composerEditSessionKey(workspaceKey, sessionId) : null;
  const editSession = useComposerEditStore((state) =>
    sessionKey ? state.sessions[sessionKey] : undefined,
  );
  const [pendingLockQueueItemId, setPendingLockQueueItemId] = useState<string | null>(null);
  const bindingRef = useRef({ sessionId, workspaceKey });
  bindingRef.current = { sessionId, workspaceKey };

  /** 释放编辑锁；返回是否已确定释放（accepted/noop），供遗留锁自愈判断是否需要重试。 */
  const releaseLock = useCallback(
    (targetSessionId: string, queueItemId: string): Promise<boolean> =>
      dispatchCommand("releaseQueueItemEdit", { queueItemId }, targetSessionId)
        .then((ack) => {
          if (ack.status === "accepted" || ack.status === "noop") return true;
          logger.warn(`[v4-composer-edit] 释放编辑锁失败: ${ack.status} ${ack.reasonCode ?? ""}`);
          return false;
        })
        .catch((error: unknown) => {
          logger.warn("[v4-composer-edit] 释放编辑锁失败", error);
          return false;
        }),
    [dispatchCommand],
  );

  const enterEditScope = useMemo(
    () =>
      createEnterEditScope({
        readAttachment,
        remoteSessionId,
        workspaceIdentity,
        workspaceKey,
        workspacePath,
      }),
    [readAttachment, remoteSessionId, workspaceIdentity, workspaceKey, workspacePath],
  );

  /**
   * 已在编辑态时切换目标：编辑内容未改动直接切（排队消息先释放旧锁），已改动先确认。
   * 暂存的始终是进入编辑态前的原草稿：原 scope 从未被编辑态改写。
   */
  const runWithSwitchGuard = useCallback(
    (action: () => void) => {
      const current = sessionKey ? getComposerEditSession(sessionKey) : undefined;
      if (!current) {
        action();
        return;
      }
      const dirty = (composerTextRef.current ?? "").trim() !== current.loadedText.trim();
      if (!dirty) {
        action();
        return;
      }
      void useConfirmDialogStore
        .getState()
        .requestConfirmation({
          testId: TID_V4_COMPOSER_EDIT_SWITCH_DIALOG,
          intent: "composer-edit-switch",
          title: intl.formatMessage({ id: "chat.composerEdit.switchTitle" }),
          description: intl.formatMessage({ id: "chat.composerEdit.switchDescription" }),
          confirmLabel: intl.formatMessage({ id: "chat.composerEdit.switchConfirm" }),
          confirmVariant: "destructive",
        })
        .then((confirmed) => {
          if (confirmed) action();
        });
    },
    [composerTextRef, intl, sessionKey],
  );

  const releaseCurrentQueueLock = useCallback(() => {
    if (!sessionKey || !sessionId) return;
    const current = getComposerEditSession(sessionKey);
    if (current?.target.kind === "queueItem")
      void releaseLock(sessionId, current.target.queueItemId);
  }, [releaseLock, sessionId, sessionKey]);

  const busyGuard = useCallback((): boolean => {
    if (!composerDraftStateRef.current?.busy) return false;
    toast(intl.formatMessage({ id: "chat.composerEdit.busy" }));
    return true;
  }, [composerDraftStateRef, intl]);

  const beginUserQueryEdit = useCallback(
    async (target: ConversationRowTarget) => {
      if (!sessionId || busyGuard()) return;
      const current = snapshotRef.current;
      const row = current?.rows.window.find((candidate) => candidate.rowId === target.rowId);
      if (!row || row.kind !== "userInput" || !row.actions?.canEdit || !row.entityId) return;
      const entityId = row.entityId;
      const { body } = splitUserInputEpilogue(row.text, row.epilogueStart);
      runWithSwitchGuard(() => {
        releaseCurrentQueueLock();
        enterEditScope(
          sessionId,
          { kind: "userQuery", rowId: row.rowId, entityId },
          {
            inputKind: "sendText",
            text: body,
            attachments: row.attachments ?? [],
            conversationQuotes: row.conversationQuotes,
            // 载入该消息提交时的配置；编辑态里可再改，提交时随 editUserQuery 携带。
            config: submittedEditConfig(row, readCurrentDraftConfig()),
          },
        );
      });
    },
    [
      busyGuard,
      enterEditScope,
      readCurrentDraftConfig,
      releaseCurrentQueueLock,
      runWithSwitchGuard,
      sessionId,
      snapshotRef,
    ],
  );

  const beginQueueItemEdit = useCallback(
    async (queueItemId: string) => {
      if (!sessionId || pendingLockQueueItemId || busyGuard()) return;
      const current = snapshotRef.current;
      const item = current?.queue.items.find((candidate) => candidate.queueItemId === queueItemId);
      if (!item || item.kind === "compact") return;
      const proceed = async () => {
        setPendingLockQueueItemId(queueItemId);
        lockRequestsInFlight.add(queueItemId);
        try {
          // 身份确认前不加锁：复制出的 Web 标签页会在确认时换新 id。
          const confirmedEditorId = await ensureEditorIdentity();
          const ack = await dispatchCommand(
            "lockQueueItemEdit",
            { queueItemId, editorId: confirmedEditorId },
            sessionId,
          );
          if (ack.status !== "accepted" && ack.status !== "duplicate") {
            const reason =
              ack.reasonCode === "guard.queueItemReserved"
                ? "reserved"
                : ack.reasonCode === "guard.queueItemEditLocked"
                  ? "locked"
                  : "generic";
            toast(intl.formatMessage({ id: `chat.composerEdit.lockFailed.${reason}` }));
            return;
          }
          const binding = bindingRef.current;
          if (binding.sessionId !== sessionId || binding.workspaceKey !== workspaceKey) {
            // ACK 返回前 pane 已切 task：不能把旧 session 的内容写进新 composer，锁也要立即还回去。
            void releaseLock(sessionId, queueItemId);
            return;
          }
          const latest = snapshotRef.current?.queue.items.find(
            (candidate) => candidate.queueItemId === queueItemId,
          );
          const source = latest ?? item;
          enterEditScope(
            sessionId,
            { kind: "queueItem", queueItemId },
            {
              inputKind: source.kind === "sendGoalCommand" ? "sendGoalCommand" : "sendText",
              text: v4QueuedCommandText(
                source.kind === "sendGoalCommand" ? "sendGoalCommand" : "sendText",
                source.text,
              ),
              attachments: source.attachments,
              conversationQuotes: source.conversationQuotes,
              config: submittedEditConfig(source, readCurrentDraftConfig()),
            },
            {
              lockConfirmed: latest?.editLock?.editorId === editorId,
            },
          );
        } catch (error) {
          logger.warn("[v4-composer-edit] 冻结队列项失败", error);
          toast(intl.formatMessage({ id: "chat.composerEdit.lockFailed.generic" }));
        } finally {
          lockRequestsInFlight.delete(queueItemId);
          setPendingLockQueueItemId(null);
        }
      };
      runWithSwitchGuard(() => {
        releaseCurrentQueueLock();
        void proceed();
      });
    },
    [
      busyGuard,
      dispatchCommand,
      editorId,
      enterEditScope,
      intl,
      pendingLockQueueItemId,
      readCurrentDraftConfig,
      releaseCurrentQueueLock,
      releaseLock,
      runWithSwitchGuard,
      sessionId,
      snapshotRef,
      workspaceKey,
    ],
  );

  const endEdit = useCallback(
    (releaseQueueLock: boolean) => {
      if (!sessionKey) return;
      const current = getComposerEditSession(sessionKey);
      if (!current) return;
      if (releaseQueueLock && sessionId && current.target.kind === "queueItem") {
        void releaseLock(sessionId, current.target.queueItemId);
      }
      useComposerEditStore.getState().end(sessionKey);
    },
    [releaseLock, sessionId, sessionKey],
  );
  // 取消不提交：composer 离开 edit scope 时按未发送规则清理其中的附件，原草稿附件不受影响。
  const cancelEdit = useCallback(() => endEdit(true), [endEdit]);
  const finishEdit = useCallback(() => endEdit(false), [endEdit]);

  const invalidReason = useComposerEditProjection({
    snapshot,
    sessionId,
    workspaceKey,
    sessionKey,
    editSession,
    editorId,
    editorIdentityConfirmed,
    releaseLock,
  });

  const releaseQueueItemEditLock = useCallback(
    (queueItemId: string) => {
      if (!sessionId) return;
      void releaseLock(sessionId, queueItemId);
    },
    [releaseLock, sessionId],
  );
  const requestEditFocus = useCallback(() => {
    if (sessionKey) useComposerEditStore.getState().requestFocus(sessionKey);
  }, [sessionKey]);

  return {
    editSession,
    invalidReason,
    editorId,
    pendingLockQueueItemId,
    beginUserQueryEdit,
    beginQueueItemEdit,
    cancelEdit,
    finishEdit,
    releaseQueueItemEditLock,
    requestEditFocus,
  };
}
