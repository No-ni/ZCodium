import type { DatabaseSync } from "node:sqlite";
import { resolveWorkspaceKey } from "@zcode/shared";
import type {
  ProjectDirectories,
  ProjectRepositoryContract,
  ProjectTaskRef,
} from "#src/project-storage/contract.js";
import {
  OWNERSHIP_DECIDED,
  readInheritedWorktreePlacement,
} from "#src/project-storage/legacy-tasks.js";
import { transaction, readTask, resolveDirectories } from "./project-repository-queries.js";
export function findCreationReceipts(
  db: DatabaseSync,
  ownerHostId: string | undefined,
  input: Parameters<ProjectRepositoryContract["findCreationReceipts"]>[0],
): Array<{ sessionId: string; directories: ProjectDirectories }> {
  // Bug 根因：原查询带 workspace_key，App 控制重试时按项目当前主目录查，主目录变了就查不到首次回执，
  // 只好按新目录重新预留并发往错误的 owner。commandId 已在调用者命名空间内唯一，按命令查即可。
  return transaction(
    db,
    () =>
      db
        .prepare(
          `SELECT c.session_id, t.workspace_path, t.workspace_identity
            FROM session_creation_commands c
            LEFT JOIN tasks t ON t.workspace_key=c.workspace_key AND t.task_id=c.session_id
            WHERE c.client_id=? AND c.command_id=?`,
        )
        .all(input.creationCommand.clientId, input.creationCommand.commandId)
        .map((row) => {
          if (typeof row.workspace_path !== "string")
            throw new Error("project.creation-task-missing");
          const task = {
            workspacePath: row.workspace_path,
            ...(typeof row.workspace_identity === "string"
              ? { workspaceIdentity: row.workspace_identity }
              : {}),
            taskId: String(row.session_id),
          };
          return {
            sessionId: task.taskId,
            directories: resolveDirectories(db, task, ownerHostId),
          };
        }),
    false,
  );
}
export function reserveForkedTask(
  db: DatabaseSync,
  ownerHostId: string | undefined,
  input: {
    task: ProjectTaskRef;
    parentTaskId: string;
  },
): ProjectDirectories {
  return transaction(db, () => {
    const parentRef = { ...input.task, taskId: input.parentTaskId };
    const parent = readTask(db, parentRef);
    if (
      !parent ||
      parent.deleted === 1 ||
      parent.cli_deleted === 1 ||
      input.task.taskId === input.parentTaskId
    )
      throw new Error("project.task-not-found");
    const directories = resolveDirectories(db, parentRef, ownerHostId);
    if (directories.workspacePath !== input.task.workspacePath)
      throw new Error("project.cwd-not-in-roots");
    // ACK 先到时也必须沿用首次事实摄入的父行继承规则，否则子任务丢失 worktree 标记，
    // 导航会误用 cwd 作为 workspace，删除占用检查也会漏掉这个子任务。
    const inherited = readInheritedWorktreePlacement(db, {
      workspaceKey: resolveWorkspaceKey(input.task),
      hostId: String(parent.host_id),
      taskId: input.parentTaskId,
    });
    const existing = readTask(db, input.task);
    if (
      existing &&
      (existing.host_id !== parent.host_id ||
        existing.root_path !== parent.root_path ||
        (existing.forked_from_task_id && existing.forked_from_task_id !== input.parentTaskId))
    )
      throw new Error("project.host-mismatch");
    if (!existing) {
      // fork 正文先由 CLI 提交；Host 在 ACK 对 UI 可见之前持久化父任务归属，避免立即打开时空归属。
      db.prepare(`INSERT INTO tasks(workspace_key,workspace_path,workspace_identity,task_id,created_at,updated_at,
          host_id,root_path,project_id,handoff_pending,execution_directories,forked_from_task_id,worktree_root)
          VALUES(?,?,?,?,0,0,?,?,?,?,?,?,?)`).run(
        resolveWorkspaceKey(input.task),
        input.task.workspacePath,
        input.task.workspaceIdentity ?? null,
        input.task.taskId,
        String(parent.host_id),
        inherited?.rootPath ?? String(parent.root_path),
        directories.projectId,
        OWNERSHIP_DECIDED,
        inherited?.executionDirectories ?? parent.execution_directories ?? null,
        input.parentTaskId,
        inherited?.worktreeRoot ?? null,
      );
    } else if (
      parent.host_id !== "local" &&
      existing.project_id == null &&
      (Number(existing.handoff_pending) & OWNERSHIP_DECIDED) === 0
    ) {
      // sessions-index 可能先于 ACK 到达；只补同父链的缺失远端归属，重放不能覆盖用户移动。
      db.prepare(`UPDATE tasks SET project_id=?,handoff_pending=handoff_pending | ?
          WHERE workspace_key=? AND task_id=? AND project_id IS NULL AND (handoff_pending & ${OWNERSHIP_DECIDED})=0`).run(
        directories.projectId,
        OWNERSHIP_DECIDED,
        resolveWorkspaceKey(input.task),
        input.task.taskId,
      );
    }
    return resolveDirectories(db, input.task, ownerHostId);
  });
}
export function releaseReservedTask(
  db: DatabaseSync,
  ownerHostId: string | undefined,
  input: Parameters<ProjectRepositoryContract["releaseReservedTask"]>[0],
): "released" | "absent" | "kept" {
  // 修复原因：曾只返回"是否删除了行"，行不存在（从未预留或已撤销过）与"行已有 CLI 事实"都返回
  // false，调用方把前者误判为会话已存在。三种结果分开返回，只有 kept 表示真实任务。
  return transaction(db, () => {
    const key = resolveWorkspaceKey(input.task);
    const row = readTask(db, input.task);
    if (row && (row.host_id !== (ownerHostId ?? "local") || row.cli_created_at != null))
      return "kept";
    if (row)
      db.prepare("DELETE FROM tasks WHERE workspace_key=? AND task_id=?").run(
        key,
        input.task.taskId,
      );
    // 创建回执随预留一起撤销，避免回执指向不存在的行，让同一命令以后报 creation-task-missing。
    db.prepare("DELETE FROM session_creation_commands WHERE workspace_key=? AND session_id=?").run(
      key,
      input.task.taskId,
    );
    return row ? "released" : "absent";
  });
}

export function listTasksByWorktree(
  db: DatabaseSync,
  ownerHostId: string | undefined,
  input: Parameters<ProjectRepositoryContract["listTasksByWorktree"]>[0],
): ReturnType<ProjectRepositoryContract["listTasksByWorktree"]> {
  // 精确匹配 worktree_root（部分索引 idx_tasks_host_worktree）；包含尚无 CLI 事实的预留行，
  // 删除检查必须把正在创建的任务也算作"使用中"。
  return db
    .prepare(
      "SELECT task_id,workspace_path,workspace_identity,project_id,cli_title,title,archived FROM tasks WHERE host_id=? AND worktree_root=? AND deleted=0 AND coalesce(cli_deleted,0)=0 ORDER BY cli_updated_at DESC,task_id",
    )
    .all(ownerHostId ?? "local", input.worktreeRoot)
    .map((row) => ({
      taskId: String(row.task_id),
      workspacePath: String(row.workspace_path),
      ...(typeof row.workspace_identity === "string"
        ? { workspaceIdentity: row.workspace_identity }
        : {}),
      projectId: typeof row.project_id === "string" ? row.project_id : null,
      title: String(row.cli_title || row.title || ""),
      archived: Number(row.archived) === 1,
    }));
}
