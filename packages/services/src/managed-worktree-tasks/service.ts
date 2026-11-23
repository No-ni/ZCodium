import { createWorktreeCreationFlow } from "./creationFlow.js";
import { createWorktreeCreationRecovery } from "./creationRecovery.js";
import { createWorktreeCreationStarts } from "./creationStarts.js";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { Emitter } from "@zcode/rpc";
import {
  MANAGED_WORKTREE_OUTPUT_LIMIT,
  type ManagedWorktreeCreation,
  type ManagedWorktreeCreationSettlement,
  type ManagedWorktreeError,
} from "@zcode/shared";
import {
  isPathInside,
  mapProjectRootsIntoWorktree,
  isSamePath,
} from "@zcode/shared/managed-worktree";
import type { ManagedWorktreeServicePorts } from "#src/managed-worktree-tasks/ports.js";
import { createWorktreeRemoval, errorOf } from "#src/managed-worktree-tasks/removal.js";
import type {
  IManagedWorktreeService,
  ManagedWorktreeGroup,
  ManagedWorktreeWorkspace,
  StartManagedWorktreeCreationResult,
} from "./contract.js";
import {
  log,
  REJECTED_ACTION_ERRORS,
  SESSION_ID_PREFIX,
  type CreationState,
} from "./creationFacts.js";

export function createManagedWorktreeService(
  ports: ManagedWorktreeServicePorts,
): IManagedWorktreeService {
  const now = ports.now ?? Date.now;
  const creations = new Map<string, CreationState>();
  const changeEmitter = new Emitter<ManagedWorktreeCreation[]>();
  const settleEmitter = new Emitter<ManagedWorktreeCreationSettlement>();

  function snapshot(): ManagedWorktreeCreation[] {
    return [...creations.values()].map((state) => ({ ...state.record }));
  }

  function publish(): void {
    changeEmitter.fire(snapshot());
    ports.reportCreatingCount?.(
      [...creations.values()].filter((state) => state.record.phase !== "failed").length,
    );
  }

  function appendOutput(state: CreationState, text: string): void {
    const output = state.record.output + text;
    state.record.output =
      output.length > MANAGED_WORKTREE_OUTPUT_LIMIT
        ? output.slice(output.length - MANAGED_WORKTREE_OUTPUT_LIMIT)
        : output;
    publish();
  }

  function fail(state: CreationState, error: ManagedWorktreeError): void {
    state.record.phase = "failed";
    state.record.error = error;
    log.warn(undefined, "worktree 创建失败", {
      creationId: state.record.id,
      kind: state.record.kind,
      code: error.code,
      // Git/RPC detail 可能包含真实路径或原始错误，只在本地创建视图展示，不落日志。
    });
    publish();
  }

  function settle(state: CreationState, settlement: ManagedWorktreeCreationSettlement): void {
    creations.delete(state.record.id);
    // 先发结束事件再推送列表：renderer 先切到真实会话，避免创建视图消失后闪出空草稿。
    settleEmitter.fire(settlement);
    publish();
    void ports.afterChange?.();
  }

  function assertLocal(): void {
    if (!ports.isLocalHost) throw new Error("worktree.local-only");
  }

  async function requireProject(projectId: string) {
    assertLocal();
    const project = (await ports.repository())
      .readTree({ includeTasks: false })
      .projects.find((item) => item.id === projectId && !item.deleted);
    if (!project) throw new Error("project.not-found");
    return project;
  }

  /**
   * worktree 任务的附加目录（I3/I16，§2.1）：源仓库内的 root 映射到 worktree 中对应的路径，
   * 起点中不存在的目录不加入；worktree 任务不能拿到源仓库主 checkout 的写权限。
   */
  async function explicitDirectories(
    projectId: string,
    placement: { sourceRoot: string; worktreeRoot: string; cwd: string },
  ): Promise<string[]> {
    const project = await requireProject(projectId);
    const candidates = mapProjectRootsIntoWorktree(
      project.roots.map((root) => root.rootPath),
      placement,
    );
    const exists = await Promise.all(
      candidates.map((path) =>
        stat(path).then(
          (stats) => stats.isDirectory(),
          () => false,
        ),
      ),
    );
    return candidates.filter((_, index) => exists[index]);
  }

  const removal = createWorktreeRemoval({
    ports,
    requireProject,
    // 创建中的 worktree 由创建记录的"放弃"处理，不允许从管理弹窗删除（§3.11）。
    isCreatingAt: (worktreeRoot) =>
      [...creations.values()].some(
        (state) =>
          state.record.worktreePath !== null && isSamePath(state.record.worktreePath, worktreeRoot),
      ),
  });
  const releaseCliSessionsUnder = removal.releaseCliSessionsUnder;
  const { sendLocal, settleStarted, run } = createWorktreeCreationFlow({
    ports,
    publish,
    fail,
    settle,
    appendOutput,
    explicitDirectories,
  });
  const { discardWorktree, resolvePreviousAttempt } = createWorktreeCreationRecovery({
    ports,
    releaseCliSessionsUnder,
    settleStarted,
  });
  const { startNewTaskNow, forkToWorktreeNow } = createWorktreeCreationStarts({
    ports,
    now,
    requireProject,
    supports,
    begin,
  });

  function requireState(creationId: string): CreationState {
    const state = creations.get(creationId);
    if (!state) throw new Error("worktree.creation-not-found");
    return state;
  }

  function findByCommand(commandId: string): CreationState | undefined {
    return [...creations.values()].find((state) => state.envelope.commandId === commandId);
  }

  function begin(state: CreationState): StartManagedWorktreeCreationResult {
    creations.set(state.record.id, state);
    publish();
    void run(state);
    return { ok: true, creationId: state.record.id };
  }

  async function supports(target: ManagedWorktreeWorkspace): Promise<boolean> {
    if (!ports.isLocalHost || target.workspaceIdentity?.trim()) return false;
    return await ports.agent.supportsWorktreeCwd(target);
  }

  function assertFailed(state: CreationState): void {
    if (state.record.phase !== "failed" || state.running)
      throw new Error("worktree.creation-not-failed");
  }

  /**
   * 同一 commandId 只启动一次创建（§10）：在第一次 await 之前同步登记，并发重放复用同一结果。
   * 修复原因：曾在幂等查找之后经过多次 await 才登记创建记录，并发重放会建出第二个 worktree。
   * 只需在本 Host 内去重：一台机器只有一个本地 Host，renderer 的命令只发往它（docs/git/worktree.md §8.3）。
   */
  const pendingStarts = new Map<string, Promise<StartManagedWorktreeCreationResult>>();
  function startOnce(
    commandId: string,
    start: () => Promise<StartManagedWorktreeCreationResult>,
  ): Promise<StartManagedWorktreeCreationResult> {
    const existing = findByCommand(commandId);
    if (existing) return Promise.resolve({ ok: true, creationId: existing.record.id });
    const pending = pendingStarts.get(commandId);
    if (pending) return pending;
    const started = start().finally(() => pendingStarts.delete(commandId));
    pendingStarts.set(commandId, started);
    return started;
  }

  return {
    startNewTask: (params) => startOnce(params.envelope.commandId, () => startNewTaskNow(params)),

    forkToWorktree: (params) =>
      startOnce(params.envelope.commandId, () => forkToWorktreeNow(params)),

    async retryCreation({ creationId }) {
      const state = requireState(creationId);
      assertFailed(state);
      // 重发前确认上一次命令：已执行则直接打开，确认未执行则换新命令 ID（§3.5）。
      state.running = true;
      try {
        if (await resolvePreviousAttempt(state)) return;
      } finally {
        state.running = false;
      }
      // 项目主目录模式下重试的是主目录发送，不再创建 worktree。
      if (!state.localMode) {
        await run(state);
        return;
      }
      state.running = true;
      try {
        await sendLocal(state);
      } catch (error) {
        fail(
          state,
          errorOf("session-failed", error instanceof Error ? error.message : String(error)),
        );
      } finally {
        state.running = false;
      }
    },

    async continueWithoutWorktree({ creationId }) {
      const state = requireState(creationId);
      assertFailed(state);
      if (state.record.kind !== "new-task") throw new Error("worktree.invalid-command");
      state.running = true;
      try {
        // 会话其实已创建时不能再发一次首条消息（§3.5）。
        if (await resolvePreviousAttempt(state)) return;
        if (!(await discardWorktree(state))) {
          settleStarted(state, state.sessionId);
          return;
        }
        // 切换为项目主目录模式：换新的会话 ID（旧 ID 的预留指向 worktree cwd）与命令 ID。
        // 修复原因：曾每次都生成新 ID 且不写回 state.sessionId，之后的放弃与重试作用在旧 ID 上。
        if (!state.localMode) {
          state.localMode = true;
          state.sessionId = `${SESSION_ID_PREFIX}${randomUUID()}`;
          state.commandId = randomUUID();
        }
        await sendLocal(state);
      } catch (error) {
        // 操作被拒绝（无法确认、worktree 正在使用、卸载会话失败）不是启动失败：原样抛给调用方
        // 按各自原因提示，记录保持原来的失败状态。
        if (error instanceof Error && REJECTED_ACTION_ERRORS.has(error.message)) throw error;
        fail(
          state,
          errorOf("session-failed", error instanceof Error ? error.message : String(error)),
        );
      } finally {
        state.running = false;
      }
    },

    async dismissCreation({ creationId }) {
      const state = requireState(creationId);
      assertFailed(state);
      state.running = true;
      try {
        if (await resolvePreviousAttempt(state)) return;
        if (!(await discardWorktree(state))) {
          settleStarted(state, state.sessionId);
          return;
        }
      } finally {
        state.running = false;
      }
      settle(state, {
        submissionCommandId: state.envelope.commandId,
        creationId,
        outcome: "dismissed",
        workspacePath: state.record.workspacePath,
        promptText: state.record.promptText,
      });
    },

    async listCreations() {
      return ports.isLocalHost ? snapshot() : [];
    },

    onDidChangeCreations: changeEmitter.event,
    onDidSettleCreation: settleEmitter.event,

    async listWorktrees(params) {
      const project = await requireProject(params.projectId);
      const repository = await ports.repository();
      const groups = new Map<string, ManagedWorktreeGroup>();
      const owned = [...creations.values()]
        .map((state) => state.record.worktreePath)
        .filter((path): path is string => Boolean(path));
      // 项目可有多个 root 属于同一仓库；按源仓库去重，每个仓库只列一次。
      for (const root of project.roots) {
        const listed = await ports.git.list({ sourcePath: root.rootPath }).catch(() => null);
        if (!listed?.sourceRoot || groups.has(listed.sourceRoot)) continue;
        groups.set(listed.sourceRoot, {
          sourceRoot: listed.sourceRoot,
          worktrees: listed.worktrees.map((worktree) => ({
            ...worktree,
            creating: owned.some((path) => isSamePath(path, worktree.path)),
            tasks: repository
              .listTasksByWorktree({ worktreeRoot: worktree.path })
              .map(({ taskId, workspacePath, workspaceIdentity, title, archived }) => ({
                taskId,
                workspacePath,
                ...(workspaceIdentity ? { workspaceIdentity } : {}),
                title,
                archived,
              })),
          })),
        });
      }
      return { groups: [...groups.values()] };
    },

    removeWorktree: (params) => removal.removeWorktree(params),

    async pruneWorktrees(params) {
      const project = await requireProject(params.projectId);
      if (!project.roots.some((root) => isPathInside(params.sourceRoot, root.rootPath)))
        throw new Error("worktree.not-managed");
      await ports.git.prune({ sourcePath: params.sourceRoot });
    },

    async listStartRefs(params) {
      const project = await requireProject(params.projectId);
      const primary = project.roots.find((root) => root.isPrimary)?.rootPath;
      return primary ? await ports.git.listStartRefs({ sourcePath: primary }) : null;
    },

    async isWorktreeAvailable(params) {
      if (!ports.isLocalHost) return true;
      return (await ports.git.resolveManagedWorktree(params.worktreeRoot)) !== null;
    },

    async supportsWorktreeCwd(params) {
      return await supports(params);
    },
  };
}
