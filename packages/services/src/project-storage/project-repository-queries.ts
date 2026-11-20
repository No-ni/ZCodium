import { isAbsolute, relative } from "node:path";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import {
  generateTraceId,
  isRemoteWorkspaceIdentity,
  resolveWorkspaceKey,
  ZCODE_AGENT_PROVIDER,
} from "@zcode/shared";
import type {
  VirtualProject,
  ProjectTaskRef,
  ProjectTask,
  ProjectDirectories,
} from "./contract.js";
import { assertRemoteTaskDirectories } from "./remote-policy.js";

export const executionDirectoriesSchema = z.array(z.string().min(1)).max(256);

export function transaction<T>(db: DatabaseSync, body: () => T, write = true): T {
  db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
  try {
    const result = body();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function readProjects(db: DatabaseSync, includeDeleted = true): VirtualProject[] {
  const roots = db
    .prepare(
      "SELECT project_id,root_path,position,is_primary FROM project_roots ORDER BY position,root_path",
    )
    .all();
  return db
    .prepare(
      `SELECT * FROM projects ${includeDeleted ? "" : "WHERE deleted=0"} ORDER BY position,project_id`,
    )
    .all()
    .map((row) => ({
      id: String(row.project_id),
      hostId: String(row.host_id),
      name: String(row.name),
      nameOverridden: row.name_overridden === 1,
      position: Number(row.position),
      pinned: row.pinned === 1,
      deleted: row.deleted === 1,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      roots: roots
        .filter((root) => root.project_id === row.project_id)
        .map((root) => ({
          rootPath: String(root.root_path),
          position: Number(root.position),
          isPrimary: root.is_primary === 1,
        })),
    }));
}

export function requireProject(db: DatabaseSync, id: string): VirtualProject {
  const project = readProjects(db).find((entry) => entry.id === id);
  if (!project) throw new Error("project.not-found");
  return project;
}

export function tableExists(db: DatabaseSync, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined
  );
}

/**
 * worktree 任务的放置：workspace 是项目，cwd 位于受管 worktree 内（docs/git/worktree.md §6.6.1）。
 * 只允许本地、有项目归属、cwd 在 worktree 根内的组合；其他组合说明调用方装配错误，直接拒绝。
 */
export function resolveWorktreePlacement(input: {
  task: { workspaceIdentity?: string };
  projectId: string | null;
  cwd?: string;
  worktreeRoot?: string;
}): { cwd: string; worktreeRoot: string } | null {
  if (input.cwd === undefined && input.worktreeRoot === undefined) return null;
  if (!input.cwd || !input.worktreeRoot) throw new Error("project.worktree-placement-incomplete");
  if (input.task.workspaceIdentity?.trim()) throw new Error("project.worktree-local-only");
  if (!input.projectId) throw new Error("project.worktree-requires-project");
  const relativeCwd = relative(input.worktreeRoot, input.cwd);
  if (relativeCwd.startsWith("..") || isAbsolute(relativeCwd))
    throw new Error("project.worktree-cwd-outside-root");
  return { cwd: input.cwd, worktreeRoot: input.worktreeRoot };
}

export function readTask(db: DatabaseSync, task: ProjectTaskRef) {
  return db
    .prepare("SELECT * FROM tasks WHERE workspace_key=? AND task_id=?")
    .get(resolveWorkspaceKey(task), task.taskId);
}

export function resolveDirectories(
  db: DatabaseSync,
  task: ProjectTaskRef,
  ownerHostId = "local",
): ProjectDirectories {
  const row = readTask(db, task);
  // 旧远端影子行仍可能保留；行与项目一致不代表当前 Host 有权加载其目录。
  if (row && row.host_id !== ownerHostId) throw new Error("project.host-mismatch");
  // root_path 是 cwd；worktree 任务的 workspace 是 workspace_path（项目主目录），两者分开返回，
  // 导航等调用方打开的是 workspace，执行目录只给需要 cwd 的调用方（§6.6.1）。
  const cwd = row ? String(row.root_path) : task.workspacePath;
  const workspacePath =
    row && typeof row.worktree_root === "string" ? String(row.workspace_path) : cwd;
  const project = row?.project_id ? requireProject(db, String(row.project_id)) : null;
  if (project && row?.host_id !== project.hostId) throw new Error("project.host-mismatch");
  assertRemoteTaskDirectories(
    ownerHostId,
    project,
    cwd,
    typeof row?.execution_directories === "string"
      ? executionDirectoriesSchema.parse(JSON.parse(row.execution_directories))
      : [],
  );
  return {
    workspacePath,
    ...(workspacePath !== cwd ? { cwd } : {}),
    ...(typeof row?.workspace_identity === "string"
      ? { workspaceIdentity: row.workspace_identity }
      : task.workspaceIdentity
        ? { workspaceIdentity: task.workspaceIdentity }
        : {}),
    projectId: project?.id ?? null,
    additionalDirectories:
      typeof row?.execution_directories === "string"
        ? executionDirectoriesSchema.parse(JSON.parse(row.execution_directories))
        : (project?.roots.map((root) => root.rootPath).filter((path) => path !== cwd) ?? []),
  };
}

export function readTasks(db: DatabaseSync): ProjectTask[] {
  // 迁移后的旧后端行也有 CLI 时间；沿用列表的 provider 边界，避免展示 Controller 无法操作的会话。
  return db
    .prepare(
      "SELECT * FROM tasks WHERE provider=? AND deleted=0 AND coalesce(cli_deleted,0)=0 AND cli_created_at IS NOT NULL ORDER BY cli_updated_at DESC,task_id",
    )
    .all(ZCODE_AGENT_PROVIDER)
    .map((row) => {
      const meta = typeof row.meta_json === "string" ? JSON.parse(row.meta_json) : {};
      return {
        ...meta,
        taskId: String(row.task_id),
        traceId: meta.traceId ?? generateTraceId(String(row.task_id)),
        // workspacePath 是任务所属 workspace；worktree 任务的 cwd 另由 cwd 给出
        // （docs/git/worktree.md §6.6.1）。普通任务两列相同，行为不变。
        workspacePath: String(row.workspace_path),
        ...(typeof row.worktree_root === "string" ? { worktreeRoot: row.worktree_root } : {}),
        ...(row.root_path && row.root_path !== row.workspace_path
          ? { cwd: String(row.root_path) }
          : {}),
        workspaceIdentity:
          row.workspace_identity === row.workspace_key
            ? String(row.workspace_identity)
            : isRemoteWorkspaceIdentity(String(row.workspace_key))
              ? String(row.workspace_key)
              : undefined,
        title: String(row.title_overridden === 1 ? row.title : (row.cli_title ?? "")),
        titleOverridden: row.title_overridden === 1 || row.cli_title_source === "custom",
        createdAt: Number(row.cli_created_at),
        updatedAt: Number(row.cli_updated_at),
        status:
          row.cli_last_outcome === "error"
            ? "error"
            : row.cli_last_outcome
              ? "completed"
              : undefined,
        mode: meta.mode ?? "default",
        pinned: row.pinned === 1,
        archived: row.archived === 1,
        unreadAt: row.unread_at == null ? undefined : Number(row.unread_at),
        projectId: row.project_id == null ? null : String(row.project_id),
        hostId: String(row.host_id),
      };
    });
}
