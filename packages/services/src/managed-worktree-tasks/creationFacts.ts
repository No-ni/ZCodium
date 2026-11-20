import { type CreateManagedWorktreeResult, type ManagedWorktreeCreation } from "@zcode/shared";
import {
  type CommandAck,
  type CommandEnvelope,
  type CommandKey,
} from "@zcode/shared/zcode-protocol-v4";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

const log = createServiceLogger("managed-worktree");

/** 无法确认最后一次会话命令是否执行；调用方不能做破坏性清理（§3.5）。 */
const COMMAND_UNCONFIRMED_ERROR = "worktree.command-unconfirmed";

/** 残留 worktree 中仍有忙碌的会话，不能删除。 */
const WORKTREE_IN_USE_ERROR = "worktree.worktree-in-use";

/** 请 CLI 卸载残留 worktree 中的会话时请求失败。 */
const SESSION_CLOSE_FAILED_ERROR = "worktree.session-close-failed";

/** 这些错误表示操作被拒绝、没有发送任何会话命令；创建记录保持原来的失败状态。 */
const REJECTED_ACTION_ERRORS: ReadonlySet<string> = new Set([
  COMMAND_UNCONFIRMED_ERROR,
  WORKTREE_IN_USE_ERROR,
  SESSION_CLOSE_FAILED_ERROR,
]);

/** 与 commandFactory 预分配会话 ID 的格式一致，CLI 按普通会话 ID 接受。 */
const SESSION_ID_PREFIX = "sess_";

interface CreationState {
  record: ManagedWorktreeCreation;
  /** 原始命令：新建任务为 createSession，fork 为 forkAssistant。 */
  envelope: CommandEnvelope;
  /** worktree 的检出源目录：新建任务为项目主目录，fork 为父任务 cwd。 */
  sourcePath: string;
  workspaceIdentity?: string;
  /** worktree 建好后保存，重试会话创建时复用。 */
  created: Extract<CreateManagedWorktreeResult, { ok: true }> | null;
  /** 预分配的会话 ID（新建任务）或子会话 ID（fork），重试时不变。 */
  sessionId: string;
  /**
   * 最后一次发给 CLI 的会话命令及其预期会话 ID。会话启动失败可能只是结果未知（请求异常），
   * 放弃前按它向 CLI 查询是否已执行（§3.5）。
   */
  sentCommand: { key: CommandKey; sessionId: string } | null;
  /**
   * 本次发送使用的命令 ID：初始为原始命令的 ID；CLI 确认上一次命令未执行时换新（§3.5）。
   * 原始命令 ID 仍用于 startNewTask / forkToWorktree 的幂等查找。
   */
  commandId: string;
  /** 选择"不使用 worktree"后为 true：sessionId 已换成项目主目录会话的 ID，之后都在主目录发送。 */
  localMode: boolean;
  running: boolean;
}

function isAccepted(ack: CommandAck): boolean {
  return ack.status === "accepted" || ack.status === "duplicate";
}

function startedSessionId(ack: CommandAck, expected: string): string {
  return ack.result?.type === "forkAssistant" || ack.result?.type === "createSession"
    ? ack.result.sessionId
    : expected;
}

function sessionIdOf(envelope: CommandEnvelope): string | undefined {
  const value = (envelope.payload as { sessionId?: unknown } | null)?.sessionId;
  return typeof value === "string" && value ? value : undefined;
}
export {
  log,
  COMMAND_UNCONFIRMED_ERROR,
  WORKTREE_IN_USE_ERROR,
  SESSION_CLOSE_FAILED_ERROR,
  REJECTED_ACTION_ERRORS,
  SESSION_ID_PREFIX,
  type CreationState,
  isAccepted,
  startedSessionId,
  sessionIdOf,
};
