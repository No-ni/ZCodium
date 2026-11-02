import { acceptComposerRecentReceipt } from "@/lib/composerRecent.js";
import {
  clearV4ComposerDraft,
  completePendingTaskDraft,
  persistV4ComposerDraft,
  readPendingTaskDraft,
  readV4ComposerDraft,
  releasePendingTaskDraftCommand,
  V4_DRAFT_SCOPE_ROOT,
} from "@/v4/composer/composerDraftStore.js";
import type { PendingCommandEntry, StorageLike } from "@/v4/pendingCommandRegistryTypes.js";

export function ownsPendingCommandDraft(entry: PendingCommandEntry): boolean {
  const composer = entry.clientContext?.composer;
  return Boolean(
    composer?.draftId && readPendingTaskDraft(composer.scope)?.draftId === composer.draftId,
  );
}

export function acceptPendingComposer(
  entry: PendingCommandEntry,
  storage: StorageLike | undefined,
): boolean {
  const composer = entry.clientContext?.composer;
  if (!composer) return true;
  if (!acceptComposerRecentReceipt(composer, storage)) return false;
  try {
    if (composer.draftId && ownsPendingCommandDraft(entry)) {
      const workspace = entry.clientContext?.workspace;
      if (!workspace || !entry.sessionId) return false;
      const draft = readV4ComposerDraft(
        workspace.workspacePath,
        workspace.workspaceIdentity,
        V4_DRAFT_SCOPE_ROOT,
        composer.scope,
      );
      // 首发期间可能已经切走；下一条输入仍归该 session，不能遗留给下一份任务目录。
      // 传输失败恢复的原文已被权威接纳，应清除而不是再次放入正式会话输入框。
      if (draft && entry.replay.kind === "input") {
        const payload = entry.replay.payload;
        const sentText =
          composer.submittedText ??
          (entry.replay.type === "createSession"
            ? (payload.firstInput as { text?: string } | undefined)?.text
            : (payload.displayText ?? payload.text));
        if (
          draft.text !== sentText &&
          !readV4ComposerDraft(
            workspace.workspacePath,
            workspace.workspaceIdentity,
            entry.sessionId,
          ) &&
          !persistV4ComposerDraft(
            workspace.workspacePath,
            workspace.workspaceIdentity,
            entry.sessionId,
            draft,
          )
        )
          return false;
      }
      if (
        !clearV4ComposerDraft(
          workspace.workspacePath,
          workspace.workspaceIdentity,
          V4_DRAFT_SCOPE_ROOT,
          composer.scope,
        )
      )
        return false;
      completePendingTaskDraft(composer.scope, composer.draftId);
    }
    return true;
  } catch {
    return false;
  }
}

export function rejectPendingComposer(entry: PendingCommandEntry): void {
  const composer = entry.clientContext?.composer;
  if (composer?.draftId)
    releasePendingTaskDraftCommand(composer.scope, composer.draftId, entry.commandId);
}
