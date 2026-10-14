import { mkdir, utimes } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { SessionId } from "@zcode/contracts";
import {
  classifyPersistedConversationExecutionPathUnusable,
  CONVERSATION_SESSION_DATE_DIR_PATTERN,
  CONVERSATION_SESSION_DATE_DIR_UNUSABLE_REASON,
  CONVERSATION_SESSION_DIR_NAME_PATTERN,
  CONVERSATION_SESSION_DIR_UNUSABLE_REASON,
  isConversationSessionWorkspacePath,
  isConversationWorkspaceEnabled,
  isManagedPersistedConversationExecutionPath,
  lstatOrUndefined,
  warnConversationSessionDirUnusable,
  type ConversationSessionWorkspaceLogger,
} from "./conversation-session-workspace-guards.js";

export class ConversationSessionWorkspaceUnavailableError extends Error {
  readonly reasonCode = "guard.conversationSessionWorkspaceUnavailable";

  constructor() {
    super("conversation session execution workspace is unavailable");
    this.name = "ConversationSessionWorkspaceUnavailableError";
  }
}

/**
 * Child runtime 的恢复/创建前置：core 不持有文件系统，因此由 bootstrap 复用同一份
 * conversation-root 判据，重建可丢失的任意深度 cwd，并在符号链接/文件占位时 fail closed。
 */
export async function prepareConversationSubagentSession(input: {
  conversationRoot: string | undefined;
  workspacePath: string;
  workspaceIdentity?: string | undefined;
  workingDirectory: string;
  sessionId: SessionId;
  resumeFromStore: boolean;
  logger?: ConversationSessionWorkspaceLogger | undefined;
  store?: {
    getSession: (sessionId: SessionId) => Promise<{
      directory: string;
      path?: string;
      workspaceID?: string;
    } | null>;
  };
}): Promise<void> {
  if (input.workspaceIdentity?.trim()) return;
  const enabled = isConversationWorkspaceEnabled(input);
  if (!enabled && (input.conversationRoot?.trim() || !input.resumeFromStore)) return;
  let conversationRoot = input.conversationRoot;
  let executionPath = input.workingDirectory;
  if (input.resumeFromStore) {
    const session = input.store ? await input.store.getSession(input.sessionId) : null;
    // 缺行交给 core 的 SessionNotFound；不能凭父 cwd 为 child 伪造目录。
    if (!session || session.workspaceID?.trim()) return;
    executionPath = session.path ?? session.directory;
    // 裸 CLI 没有 Host 标记，但恢复 child/actor 仍直接走 core；按持久化受管判据补上
    // 与主会话相同的门禁，不能让缺失目录或坏链接绕过 bootstrap 的恢复准备。
    if (!enabled) {
      if (!isManagedPersistedConversationExecutionPath(executionPath, session.directory)) return;
      conversationRoot = session.directory;
    }
  }
  if (resolve(executionPath) === resolve(conversationRoot ?? input.workspacePath)) {
    throw new ConversationSessionWorkspaceUnavailableError();
  }
  // 显式进入对话根之外的 cwd 不属于本规则的目录所有权，保留旧行为。
  if (!isConversationSessionWorkspacePath(executionPath, conversationRoot)) return;
  const unusableReason = classifyPersistedConversationExecutionPathUnusable({
    conversationRoot,
    persistedPath: executionPath,
  });
  if (unusableReason) {
    warnConversationSessionDirUnusable(input.logger, unusableReason);
    throw new ConversationSessionWorkspaceUnavailableError();
  }
  await ensureConversationSessionWorkspaceDir(executionPath);
}

/**
 * 建立会话执行目录（幂等，含中间日期目录），并刷新目录 mtime。
 *
 * 刷新 mtime 是启动清扫的年龄门禁所必需：mkdir 对已存在目录不改 mtime。创建、恢复和 fork 继承
 * 都经过这里；刷新失败不影响会话本身。
 */
export async function ensureConversationSessionWorkspaceDir(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const now = new Date();
  await utimes(directory, now, now).catch(() => undefined);
}

/**
 * 执行准入时复核独立会话 cwd，并重建被启动清扫或用户删除的目录。
 *
 * 创建/恢复仍可为坏占位路径保留旧的只读投影兼容；但真正执行不能把缺失或降级到对话根的 cwd
 * 写入共享目录。仅在 Host 明确启用本规则时生效，项目、远端与旧宿主保持原行为。
 */
export async function ensureConversationSessionWorkspaceForExecution(input: {
  conversationRoot: string | undefined;
  workspacePath: string;
  workspaceIdentity?: string | undefined;
  executionWorkspacePath?: string | undefined;
  logger?: ConversationSessionWorkspaceLogger | undefined;
}): Promise<void> {
  if (!isConversationWorkspaceEnabled(input)) {
    return;
  }

  const executionWorkspacePath = input.executionWorkspacePath?.trim();
  if (
    !executionWorkspacePath ||
    !isConversationSessionWorkspacePath(executionWorkspacePath, input.conversationRoot)
  ) {
    throw new ConversationSessionWorkspaceUnavailableError();
  }

  const conversationRoot = resolve(input.conversationRoot ?? "");
  const relativePath = relative(conversationRoot, resolve(executionWorkspacePath));
  const segments = relativePath.split(/[\\/]/u);

  const unusableReason = classifyPersistedConversationExecutionPathUnusable({
    conversationRoot: input.conversationRoot,
    persistedPath: executionWorkspacePath,
  });
  if (unusableReason) {
    warnConversationSessionDirUnusable(input.logger, unusableReason);
    throw new ConversationSessionWorkspaceUnavailableError();
  }

  let current = conversationRoot;
  let missingAt = -1;
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]!);
    const entry = lstatOrUndefined(current);
    if (!entry) {
      missingAt = index;
      break;
    }
    if (!entry.isDirectory()) {
      warnConversationSessionDirUnusable(
        input.logger,
        index === 0
          ? CONVERSATION_SESSION_DATE_DIR_UNUSABLE_REASON
          : CONVERSATION_SESSION_DIR_UNUSABLE_REASON,
      );
      throw new ConversationSessionWorkspaceUnavailableError();
    }
  }

  if (missingAt >= 0) {
    // fork/子会话可继承父 cd 后的深层执行根；前两段决定所有权，缺失的后代也应重建。
    const isOwnedPath =
      segments.length >= 2 &&
      CONVERSATION_SESSION_DATE_DIR_PATTERN.test(segments[0]!) &&
      CONVERSATION_SESSION_DIR_NAME_PATTERN.test(segments[1]!);
    if (!isOwnedPath) {
      throw new ConversationSessionWorkspaceUnavailableError();
    }
    try {
      await ensureConversationSessionWorkspaceDir(executionWorkspacePath);
    } catch {
      throw new ConversationSessionWorkspaceUnavailableError();
    }
  } else if (segments.length === 2) {
    try {
      await ensureConversationSessionWorkspaceDir(executionWorkspacePath);
    } catch {
      throw new ConversationSessionWorkspaceUnavailableError();
    }
  }
}
