import { useEffect, useMemo, useRef } from "react";
import type { AttachmentRef, ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { createUuid, isHighspeedProviderId, type ConversationSelectionText } from "@zcode/shared";
import {
  isConversationSelectionReference,
  setConversationSelectionReferenceScope,
} from "@/lib/conversationSelectionReference.js";
import { logger } from "@/logger.js";
import { parseConversationShareContext } from "@/lib/conversationShareContext.js";
import { parseComposerPromptContexts } from "@/v4/composer/composerPromptContexts.js";
import { persistV4ComposerDraft, type V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
import {
  replaceComposerAttachmentsForScope,
  setComposerAttachmentPreviewUrlForScope,
} from "@/v4/composer/useComposerAttachments.js";
import type { ConversationTransport } from "@/v4/transport.js";
import { seedCodeCommentContextsForScope } from "@/v4/composer/useCodeCommentContexts.js";
import { seedWebElementContextsForScope } from "@/v4/composer/useWebElementContexts.js";
import { seedPptxElementReferencesForScope } from "@/v4/composer/usePptxElementReferences.js";
import { composerEditSessionKey } from "./contract.js";
import type {
  ComposerEditInvalidReason,
  ComposerEditSession,
  ComposerEditTarget,
} from "./contract.js";
import {
  createComposerEditScopeId,
  getComposerEditSession,
  useComposerEditStore,
} from "./store.js";

type DraftConfig = Pick<V4ComposerDraft, "mode" | "planEnabled" | "modelSelection">;

interface EditContent {
  inputKind: "sendText" | "sendGoalCommand";
  /** 含序列化上下文块的原文；载入时拆成可见正文与 chip。 */
  text: string;
  attachments: readonly AttachmentRef[];
  conversationQuotes?: readonly ConversationSelectionText[];
  config: DraftConfig;
}

/** lock ACK 前投影可能已出现本端锁：这段窗口内自愈逻辑不能把它当成遗留锁释放。 */
const lockRequestsInFlight = new Set<string>();

/**
 * 编辑一条消息时工具栏载入它提交时的配置（最后一条消息与排队项同一规则，docs/ui/composer-edit-mode.md）；
 * 旧消息/旧队列项缺少的字段保留当前草稿配置。旧版本曾把单轮 Highspeed Provider 持久化进输入，
 * 载入工具栏会污染后续 fallback，因此不载入 Highspeed 模型。
 */
function submittedEditConfig(
  submitted: Pick<DraftConfig, "mode" | "planEnabled" | "modelSelection">,
  fallback: DraftConfig,
): DraftConfig {
  const modelSelection =
    submitted.modelSelection && !isHighspeedProviderId(submitted.modelSelection.providerId)
      ? submitted.modelSelection
      : undefined;
  return {
    mode: submitted.mode ?? fallback.mode,
    planEnabled: submitted.planEnabled ?? fallback.planEnabled,
    modelSelection: modelSelection ?? fallback.modelSelection,
  };
}

// 预置操作跨渲染复用，但不能与 dispatch/releaseLock 共享作用域；否则旧命令回调仍持有旧 pane。
function createEnterEditScope({
  readAttachment,
  remoteSessionId,
  workspaceIdentity,
  workspaceKey,
  workspacePath,
}: {
  readAttachment?: ConversationTransport["attachmentRead"];
  remoteSessionId?: string;
  workspaceIdentity?: string;
  workspaceKey: string;
  workspacePath: string;
}) {
  return (
    targetSessionId: string,
    target: ComposerEditTarget,
    content: EditContent,
    extra?: Partial<ComposerEditSession>,
  ) => {
    const scopeId = createComposerEditScopeId(targetSessionId);
    const parsed = parseComposerPromptContexts(content.text, {
      workspacePath,
      workspaceIdentity,
    });
    const visibleText = parseConversationShareContext(parsed.visibleContent).visibleContent;
    persistV4ComposerDraft(workspacePath, workspaceIdentity, scopeId, {
      text: visibleText,
      ...content.config,
    });
    const attachmentItems = replaceComposerAttachmentsForScope(
      workspacePath,
      workspaceIdentity,
      scopeId,
      content.attachments,
    );
    // Bug 根因：session-owned 附件没有本地 objectUrl，编辑态媒体卡既无缩略图也无法打开 gallery
    // （VI06/VI07 视频预览 E2E）。与消息行一致按原序号读回；视频带 row target，
    // 删除前面的附件后预览仍按持久化原序号读取。
    if (readAttachment) {
      content.attachments.forEach((attachment, index) => {
        const isVideo = attachment.mime.startsWith("video/");
        if (!isVideo && !attachment.mime.startsWith("image/")) return;
        const item = attachmentItems[index];
        if (!item) return;
        void readAttachment({
          sessionId: targetSessionId,
          ref: attachment.previewRef ?? attachment.ref,
          ...(isVideo ? { mediaType: attachment.mime } : {}),
          ...(isVideo && target.kind === "userQuery"
            ? {
                target: { rowId: target.rowId, entityId: target.entityId },
                attachmentIndex: index,
              }
            : {}),
        })
          .then((result) => {
            const url =
              "url" in result
                ? result.url
                : URL.createObjectURL(
                    new Blob([Uint8Array.from(result.bytes)], { type: result.mediaType }),
                  );
            const applied = setComposerAttachmentPreviewUrlForScope(
              workspacePath,
              workspaceIdentity,
              scopeId,
              item.id,
              url,
            );
            if (!applied && !("url" in result)) URL.revokeObjectURL(url);
          })
          .catch((error: unknown) =>
            logger.warn("[v4-composer-edit] 读取编辑态附件预览失败", error),
          );
      });
    }
    seedCodeCommentContextsForScope(`${workspaceKey}\0${scopeId}`, parsed.codeComments);
    seedWebElementContextsForScope(workspacePath, workspaceIdentity, scopeId, parsed.webElements);
    seedPptxElementReferencesForScope(
      { workspacePath, workspaceIdentity, remoteSessionId },
      scopeId,
      parsed.pptxElements,
    );
    // 会话引用载入为 composer 的引用 chip，提交时作为结构化 quotes 带回。
    // Bug 根因：曾只读结构化 conversationQuotes；正文尾部 `# userselect:` 块形式的引用被
    // parseComposerPromptContexts 从可见正文剥离后直接丢失（AL 附件布局 E2E 编辑态少一个 chip）。
    // 与原行内编辑器一致：有结构化 quotes 用它，否则用正文解析出的引用。
    const selections = content.conversationQuotes ?? parsed.conversationSelections;
    setConversationSelectionReferenceScope(
      scopeId,
      workspaceKey,
      selections.map((quote) =>
        isConversationSelectionReference(quote)
          ? quote
          : {
              ...quote,
              id: createUuid(),
              sourceSessionId: targetSessionId,
              sourceRowId: target.kind === "userQuery" ? target.rowId : 0,
              contentType: "user" as const,
            },
      ),
    );
    useComposerEditStore.getState().begin(composerEditSessionKey(workspaceKey, targetSessionId), {
      target,
      scopeId,
      inputKind: content.inputKind,
      loadedText: visibleText,
      lockConfirmed: false,
      ...extra,
    });
  };
}

// Bug 原因：投影 effect 与长期复用的编辑回调共享词法作用域，旧回调会连带保留整份历史。
// 独立作用域只负责本轮投影校验和锁同步；事件处理仍通过 snapshotRef 读取当前投影。
function useComposerEditProjection({
  snapshot,
  sessionId,
  workspaceKey,
  sessionKey,
  editSession,
  editorId,
  editorIdentityConfirmed,
  releaseLock,
}: {
  snapshot: ConversationSnapshot | null;
  sessionId: string | null;
  workspaceKey: string;
  sessionKey: string | null;
  editSession: ComposerEditSession | undefined;
  editorId: string;
  editorIdentityConfirmed: boolean;
  releaseLock: (sessionId: string, queueItemId: string) => Promise<boolean>;
}): ComposerEditInvalidReason | null {
  // 失效只依据投影：最后一条消息不再可编辑、队列项已不存在、或锁已不属于本编辑器。
  const invalidReason = useMemo<ComposerEditInvalidReason | null>(() => {
    if (!editSession || !snapshot || snapshot.sessionId !== sessionId) return null;
    const target = editSession.target;
    if (target.kind === "userQuery") {
      const row = snapshot.rows.window.find((candidate) => candidate.rowId === target.rowId);
      return row && row.kind === "userInput" && row.actions?.canEdit ? null : "notLatest";
    }
    const item = snapshot.queue.items.find(
      (candidate) => candidate.queueItemId === target.queueItemId,
    );
    if (!item) return "queueItemRemoved";
    if (editSession.lockConfirmed && item.editLock?.editorId !== editorId) return "editLockLost";
    return null;
  }, [editSession, editorId, sessionId, snapshot]);

  useEffect(() => {
    if (!editSession || editSession.lockConfirmed || !sessionKey || !snapshot) return;
    const target = editSession.target;
    if (target.kind !== "queueItem") return;
    const item = snapshot.queue.items.find(
      (candidate) => candidate.queueItemId === target.queueItemId,
    );
    if (item?.editLock?.editorId === editorId) {
      useComposerEditStore.getState().update(sessionKey, { lockConfirmed: true });
    }
  }, [editSession, editorId, sessionKey, snapshot]);

  // 刷新或重启后：投影里属于本编辑器的锁没有对应编辑态，说明发起端已丢失编辑，立即释放。
  // Bug 根因：曾在发出释放时就把项永久标成已处理，释放失败（断线、非 accepted ACK）后不再重试，
  // 队首一直冻结。标记只代表「进行中或已确定释放」，失败即清除，下一次投影更新时重试；
  // 释放完成前该行显示「解除」入口（ConversationQueuePanel），用户也可手动处理。
  const releasedOrphanLocksRef = useRef(new Set<string>());
  useEffect(() => {
    if (!editorIdentityConfirmed) return;
    if (!sessionId || !snapshot || snapshot.sessionId !== sessionId) return;
    for (const item of snapshot.queue.items) {
      if (item.editLock?.editorId !== editorId) continue;
      if (lockRequestsInFlight.has(item.queueItemId)) continue;
      const active = getComposerEditSession(composerEditSessionKey(workspaceKey, sessionId));
      if (active?.target.kind === "queueItem" && active.target.queueItemId === item.queueItemId) {
        continue;
      }
      if (releasedOrphanLocksRef.current.has(item.queueItemId)) continue;
      releasedOrphanLocksRef.current.add(item.queueItemId);
      logger.info("[v4-composer-edit] 释放本编辑器遗留的队列编辑锁", {
        queueItemId: item.queueItemId,
        sessionId,
      });
      const queueItemId = item.queueItemId;
      void releaseLock(sessionId, queueItemId).then((released) => {
        if (!released) releasedOrphanLocksRef.current.delete(queueItemId);
      });
    }
  }, [editorId, editorIdentityConfirmed, releaseLock, sessionId, snapshot, workspaceKey]);

  return invalidReason;
}
export {
  type DraftConfig,
  type EditContent,
  lockRequestsInFlight,
  submittedEditConfig,
  createEnterEditScope,
  useComposerEditProjection,
};
