import { type ManagedWorktreeCreationSettlement, type ManagedWorktreeError } from "@zcode/shared";
import { type CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import type { ManagedWorktreeServicePorts } from "#src/managed-worktree-tasks/ports.js";
import { errorOf } from "#src/managed-worktree-tasks/removal.js";
import { log, type CreationState, isAccepted, startedSessionId } from "./creationFacts.js";
interface Context {
  ports: ManagedWorktreeServicePorts;
  publish(): void;
  fail(state: CreationState, error: ManagedWorktreeError): void;
  settle(state: CreationState, settlement: ManagedWorktreeCreationSettlement): void;
  appendOutput(state: CreationState, text: string): void;
  explicitDirectories(
    projectId: string,
    placement: { sourceRoot: string; worktreeRoot: string; cwd: string },
  ): Promise<string[]>;
}
// 创建记录由 service 唯一持有；这里执行同一记录的步骤，不复制队列或状态。
export function createWorktreeCreationFlow({
  ports,
  publish,
  fail,
  settle,
  appendOutput,
  explicitDirectories,
}: Context) {
  /** 在项目主目录发送首条消息（"不使用 worktree"与它之后的重试）。 */
  async function sendLocal(state: CreationState): Promise<void> {
    const commandId = state.commandId;
    state.record.phase = "starting-session";
    state.record.error = null;
    publish();
    state.sentCommand = { key: { sessionId: null, commandId }, sessionId: state.sessionId };
    const ack = await ports.agent.sendCommand({
      workspacePath: state.record.workspacePath,
      projectId: state.record.projectId,
      envelope: {
        ...state.envelope,
        commandId,
        payload: {
          ...(state.envelope.payload as Record<string, unknown>),
          sessionId: state.sessionId,
        },
      },
    });
    if (!isAccepted(ack)) {
      fail(state, errorOf("session-failed", ack.reasonCode ?? ack.status));
      return;
    }
    settleStarted(state, startedSessionId(ack, state.sessionId));
  }

  function settleStarted(state: CreationState, sessionId: string): void {
    log.info(undefined, "worktree 任务已启动", {
      creationId: state.record.id,
      kind: state.record.kind,
      sessionId,
    });
    settle(state, {
      submissionCommandId: state.envelope.commandId,
      creationId: state.record.id,
      outcome: "session-started",
      workspacePath: state.record.workspacePath,
      sessionId,
    });
  }

  async function createWorktree(state: CreationState): Promise<boolean> {
    const created = await ports.git.create(
      {
        sourcePath: state.sourcePath,
        ...(state.record.ref ? { startRef: state.record.ref } : {}),
        // fork 的新 worktree 是父任务 cwd 当前状态的副本，带入未提交改动（§3.6）。
        ...(state.record.kind === "fork" ? { carryChanges: true } : {}),
      },
      {
        onOutput: (text) => appendOutput(state, text),
        onPathAllocated: (path) => {
          state.record.worktreePath = path;
          publish();
        },
      },
    );
    if (!created.ok) {
      state.record.worktreePath = null;
      fail(state, created.error);
      return false;
    }
    state.created = created;
    state.record.worktreePath = created.worktree.path;
    return true;
  }

  async function startSession(state: CreationState): Promise<void> {
    const created = state.created!;
    state.record.phase = "starting-session";
    state.record.error = null;
    publish();
    const repository = await ports.repository();
    const worktreeCreation = {
      path: created.worktree.path,
      sha: created.worktree.head ?? "",
      ref: state.record.ref,
      output: state.record.output,
    };
    // 先于 CLI 写入任务行：workspace = 项目，cwd 与 worktree 根只在这里写一次（§6.6.1）。
    repository.reserveCreatedTask({
      task: {
        workspacePath: state.record.workspacePath,
        ...(state.workspaceIdentity ? { workspaceIdentity: state.workspaceIdentity } : {}),
        taskId: state.sessionId,
      },
      projectId: state.record.projectId,
      cwd: created.cwd,
      worktreeRoot: created.worktree.path,
      additionalDirectories: await explicitDirectories(state.record.projectId, {
        sourceRoot: created.worktree.sourceRoot,
        worktreeRoot: created.worktree.path,
        cwd: created.cwd,
      }),
    });
    const payload = state.envelope.payload as Record<string, unknown>;
    const envelope: CommandEnvelope =
      state.record.kind === "new-task"
        ? {
            ...state.envelope,
            commandId: state.commandId,
            payload: { ...payload, sessionId: state.sessionId, cwd: created.cwd, worktreeCreation },
          }
        : {
            ...state.envelope,
            commandId: state.commandId,
            payload: {
              ...payload,
              targetCwd: { cwd: created.cwd, childSessionId: state.sessionId, worktreeCreation },
            },
          };
    state.sentCommand = {
      key: {
        sessionId: state.record.kind === "new-task" ? null : (state.envelope.sessionId ?? null),
        commandId: envelope.commandId,
      },
      sessionId: state.sessionId,
    };
    const ack = await ports.agent.sendCommand({
      workspacePath: state.record.workspacePath,
      ...(state.workspaceIdentity ? { workspaceIdentity: state.workspaceIdentity } : {}),
      ...(state.record.kind === "new-task" ? { projectId: state.record.projectId } : {}),
      envelope,
    });
    if (!isAccepted(ack)) {
      // worktree 保留：重试只重做会话创建，重发前先向 CLI 确认这次命令的结果（§3.5）。
      fail(state, errorOf("session-failed", ack.reasonCode ?? ack.status));
      return;
    }
    settleStarted(state, startedSessionId(ack, state.sessionId));
  }

  async function run(state: CreationState): Promise<void> {
    if (state.running) return;
    state.running = true;
    try {
      if (!state.created) {
        state.record.phase = "creating";
        state.record.error = null;
        publish();
        if (!(await createWorktree(state))) return;
      }
      await startSession(state);
    } catch (error) {
      fail(
        state,
        errorOf("session-failed", error instanceof Error ? error.message : String(error)),
      );
    } finally {
      state.running = false;
    }
  }
  return { sendLocal, settleStarted, createWorktree, startSession, run };
}
