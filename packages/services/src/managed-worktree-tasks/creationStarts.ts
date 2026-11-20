import { randomUUID } from "node:crypto";
import { isSamePath } from "@zcode/shared/managed-worktree";
import type { ManagedWorktreeServicePorts } from "#src/managed-worktree-tasks/ports.js";
import { errorOf } from "#src/managed-worktree-tasks/removal.js";
import type {
  IManagedWorktreeService,
  ManagedWorktreeWorkspace,
  StartManagedWorktreeCreationResult,
} from "./contract.js";
import { SESSION_ID_PREFIX, type CreationState, sessionIdOf } from "./creationFacts.js";
interface Context {
  ports: ManagedWorktreeServicePorts;
  now(): number;
  requireProject(
    projectId: string,
  ): Promise<
    ReturnType<
      Awaited<ReturnType<ManagedWorktreeServicePorts["repository"]>>["readTree"]
    >["projects"][number]
  >;
  supports(target: ManagedWorktreeWorkspace): Promise<boolean>;
  begin(state: CreationState): StartManagedWorktreeCreationResult;
}
// 创建记录由 service 唯一持有；这里执行同一记录的步骤，不复制队列或状态。
export function createWorktreeCreationStarts({
  ports,
  now,
  requireProject,
  supports,
  begin,
}: Context) {
  async function startNewTaskNow(
    params: Parameters<IManagedWorktreeService["startNewTask"]>[0],
  ): Promise<StartManagedWorktreeCreationResult> {
    if (params.workspaceIdentity?.trim()) return { ok: false, error: errorOf("local-only") };
    const { envelope } = params;
    const payload = envelope.payload as { firstInput?: { text?: unknown } } | null;
    if (envelope.type !== "createSession" || !payload?.firstInput)
      throw new Error("worktree.invalid-command");
    const project = await requireProject(params.projectId);
    // worktree 只从项目主目录检出（§3.2）；其他目录说明草稿与项目不一致。
    const primary = project.roots.find((root) => root.isPrimary)?.rootPath;
    if (!primary || !isSamePath(primary, params.workspacePath))
      throw new Error("worktree.not-primary-root");
    if (!(await supports(params))) return { ok: false, error: errorOf("unsupported-agent") };
    return begin({
      record: {
        id: randomUUID(),
        kind: "new-task",
        projectId: params.projectId,
        workspacePath: params.workspacePath,
        phase: "creating",
        ref: params.ref,
        worktreePath: null,
        output: "",
        error: null,
        promptText: typeof payload.firstInput.text === "string" ? payload.firstInput.text : "",
        parentSessionId: null,
        createdAt: now(),
      },
      envelope,
      sourcePath: params.workspacePath,
      created: null,
      sessionId: sessionIdOf(envelope) ?? `${SESSION_ID_PREFIX}${randomUUID()}`,
      sentCommand: null,
      commandId: envelope.commandId,
      localMode: false,
      running: false,
    });
  }

  async function forkToWorktreeNow(
    params: Parameters<IManagedWorktreeService["forkToWorktree"]>[0],
  ): Promise<StartManagedWorktreeCreationResult> {
    if (!ports.isLocalHost || params.workspaceIdentity?.trim())
      return { ok: false, error: errorOf("local-only") };
    const { envelope } = params;
    if (envelope.type !== "forkAssistant" || !envelope.sessionId)
      throw new Error("worktree.invalid-command");
    if (!(await supports(params))) return { ok: false, error: errorOf("unsupported-agent") };
    // 父任务的 cwd 与项目取 tasks-index（不信任 UI 传入）。
    const parent = (await ports.repository()).resolveSessionDirectories({
      workspacePath: params.workspacePath,
      taskId: envelope.sessionId,
    });
    if (!parent.projectId) throw new Error("worktree.requires-project");
    return begin({
      record: {
        id: randomUUID(),
        kind: "fork",
        projectId: parent.projectId,
        workspacePath: params.workspacePath,
        phase: "creating",
        ref: null,
        worktreePath: null,
        output: "",
        error: null,
        promptText: null,
        parentSessionId: envelope.sessionId,
        createdAt: now(),
      },
      envelope,
      // worktree 从父任务 cwd 检出（父任务本身可能在另一个 worktree 中）。
      sourcePath: parent.cwd ?? parent.workspacePath,
      created: null,
      sessionId: `${SESSION_ID_PREFIX}${randomUUID()}`,
      sentCommand: null,
      commandId: envelope.commandId,
      localMode: false,
      running: false,
    });
  }
  return { startNewTaskNow, forkToWorktreeNow };
}
