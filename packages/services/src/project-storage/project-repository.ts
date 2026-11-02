import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isRemoteWorkspaceIdentity, resolveWorkspaceKey } from "@zcode/shared";
import type {
  AutoArchiveInput,
  ProjectDirectories,
  ProjectRepositoryContract,
  ProjectTaskRef,
  ProjectTree,
  SaveProjectInput,
  VirtualProject,
} from "#src/project-storage/contract.js";
import { OWNERSHIP_DECIDED } from "#src/project-storage/legacy-tasks.js";
import type { ProjectDataRepositoryContract } from "#src/project-storage/purge/contract.js";
import {
  assertRemoteProjectRoots,
  assertRemoteTaskDirectories,
} from "#src/project-storage/remote-policy.js";

import {
  transaction,
  readProjects,
  requireProject,
  tableExists,
  readTask,
  resolveDirectories,
  readTasks,
} from "./project-repository-queries.js";
import { reserveProjectTask } from "./project-task-creation.js";

export class ProjectRepository implements ProjectRepositoryContract, ProjectDataRepositoryContract {
  constructor(
    private readonly db: DatabaseSync,
    private readonly ownerHostId?: string,
  ) {}

  archiveInactive(input: AutoArchiveInput): ProjectTaskRef[] {
    return transaction(this.db, () => {
      const active = new Set(
        input.activeTasks.map((task) => JSON.stringify([resolveWorkspaceKey(task), task.taskId])),
      );
      // 2026-09-15 裁决：纯按 CLI 最后活动时间归档，不再看 last_outcome 与未读；
      // 只有置顶和 syncer 观察到的运行中会话除外。旧判据把 error / 无结果的老会话永远留在列表里。
      const candidates = this.db
        .prepare(`SELECT workspace_key,workspace_path,workspace_identity,task_id FROM tasks
        WHERE archived=0 AND pinned=0 AND deleted=0 AND coalesce(cli_deleted,0)=0
        AND cli_updated_at < ? AND host_id=?`)
        .all(input.cutoff, this.ownerHostId ?? "local");
      const result: ProjectTaskRef[] = [];
      for (const row of candidates) {
        if (active.has(JSON.stringify([row.workspace_key, row.task_id]))) continue;
        this.db
          .prepare("UPDATE tasks SET archived=1 WHERE workspace_key=? AND task_id=?")
          .run(row.workspace_key!, row.task_id!);
        result.push({
          workspacePath: String(row.workspace_path),
          taskId: String(row.task_id),
          workspaceIdentity:
            row.workspace_identity === row.workspace_key
              ? String(row.workspace_identity)
              : isRemoteWorkspaceIdentity(String(row.workspace_key))
                ? String(row.workspace_key)
                : undefined,
        });
      }
      return result;
    });
  }

  readTree(options?: {
    includeDeleted?: boolean;
    includeDeletedTasks?: boolean;
    includeTasks?: boolean;
  }): ProjectTree {
    const read = () => ({
      projects: readProjects(this.db, options?.includeDeleted ?? false).filter(
        (project) => project.hostId === (this.ownerHostId ?? "local"),
      ),
      ...(options?.includeDeletedTasks
        ? {
            deletedTasks: this.db
              .prepare(`
        SELECT task_id AS taskId,workspace_path AS workspacePath,workspace_identity AS workspaceIdentity,host_id AS hostId
        FROM tasks WHERE host_id=? AND (deleted=1 OR coalesce(cli_deleted,0)=1)`)
              .all(this.ownerHostId ?? "local")
              .map((row) => ({
                taskId: String(row.taskId),
                workspacePath: String(row.workspacePath),
                hostId: String(row.hostId),
                ...(typeof row.workspaceIdentity === "string"
                  ? { workspaceIdentity: row.workspaceIdentity }
                  : {}),
              })),
          }
        : {}),
      tasks:
        options?.includeTasks === false
          ? []
          : readTasks(this.db).filter((task) => task.hostId === (this.ownerHostId ?? "local")),
    });
    return this.db.isTransaction ? read() : transaction(this.db, read, false);
  }

  saveProject(input: SaveProjectInput): VirtualProject {
    return transaction(this.db, () => {
      const old =
        input.id || input.restoreProjectId
          ? requireProject(this.db, input.id ?? input.restoreProjectId!)
          : undefined;
      if (input.id && old?.deleted) throw new Error("project.deleted");
      const hostId = this.ownerHostId ?? "local";
      if (old && old.hostId !== hostId) throw new Error("project.cross-host-move");
      if (input.hostId && input.hostId !== hostId) throw new Error("project.host-immutable");
      const roots = [...new Set(input.roots ?? old?.roots.map((root) => root.rootPath) ?? [])];
      assertRemoteProjectRoots(this.ownerHostId, roots, old);
      if (input.reuseExistingRoot) {
        if (hostId !== "local" || old || roots.length !== 1)
          throw new Error("project.invalid-directory-open");
        // 系统打开目录曾只建立 workspace，导致草稿没有项目；查找和创建必须在同一
        // 写事务内完成，避免多窗口并发右键创建重复项目。复用不改已有名称、roots 或排序。
        const existing = this.db
          .prepare(`
          SELECT p.project_id FROM projects p JOIN project_roots r ON r.project_id=p.project_id
          WHERE p.host_id=? AND p.deleted=0 AND r.root_path=?
          ORDER BY r.is_primary DESC,p.position,p.project_id LIMIT 1
        `)
          .get(hostId, roots[0]!);
        if (existing) return requireProject(this.db, String(existing.project_id));
      }
      if (
        input.restoreProjectId &&
        (!old?.deleted ||
          roots.length !== old.roots.length ||
          roots.some((root) => !old.roots.some((entry) => entry.rootPath === root)))
      )
        throw new Error("project.restore-roots-mismatch");
      const primary =
        input.primaryRoot ??
        old?.roots.find((root) => root.isPrimary && roots.includes(root.rootPath))?.rootPath ??
        roots[0];
      if (primary !== undefined && !roots.includes(primary))
        throw new Error("project.invalid-primary-root");
      const id = old?.id ?? randomUUID();
      const overridden =
        input.name !== undefined ? input.name.trim().length > 0 : (old?.nameOverridden ?? false);
      const baseName =
        input.name?.trim() ||
        (overridden ? old?.name : undefined) ||
        (roots[0] ? basename(roots[0]) : input.defaultName?.trim() || old?.name || "New project");
      let name = baseName;
      for (
        let suffix = 2;
        this.db
          .prepare(
            "SELECT 1 FROM projects WHERE host_id=? AND name=? AND deleted=0 AND project_id<>?",
          )
          .get(hostId, name, id);
        suffix++
      )
        name = `${baseName} (${suffix})`;
      const now = Date.now();
      // 原先用 max(position)+1 导致新建项目落在末尾；同一 Host 写事务内取最小值减一，保留已有顺序。
      this.db
        .prepare(`INSERT INTO projects(project_id,host_id,name,name_overridden,position,pinned,pinned_at,created_at,updated_at)
        VALUES(?,?,?,?,(SELECT coalesce(min(position),1)-1 FROM projects WHERE host_id=?),?,?,?,?)
        ON CONFLICT(project_id) DO UPDATE SET name=excluded.name,name_overridden=excluded.name_overridden,
        pinned=excluded.pinned,pinned_at=excluded.pinned_at,deleted=0,deleted_at=NULL,updated_at=excluded.updated_at`)
        .run(
          id,
          hostId,
          name,
          overridden ? 1 : 0,
          hostId,
          (input.pinned ?? old?.pinned) ? 1 : 0,
          (input.pinned ?? old?.pinned) ? now : null,
          now,
          now,
        );
      this.db.prepare("DELETE FROM project_roots WHERE project_id=?").run(id);
      roots.forEach((root, position) =>
        this.db
          .prepare(
            "INSERT INTO project_roots(project_id,root_path,position,is_primary) VALUES(?,?,?,?)",
          )
          .run(id, root, position, root === primary ? 1 : 0),
      );
      return requireProject(this.db, id);
    });
  }

  initializeProjectRoot(id: string, path: string): VirtualProject {
    return transaction(this.db, () => {
      const project = requireProject(this.db, id);
      if (project.hostId !== (this.ownerHostId ?? "local"))
        throw new Error("project.cross-host-move");
      if (project.deleted) throw new Error("project.deleted");
      assertRemoteProjectRoots(this.ownerHostId, [path], project);
      if (!project.roots.length) {
        this.db
          .prepare(
            "INSERT INTO project_roots(project_id,root_path,position,is_primary) VALUES(?,?,0,1)",
          )
          .run(id, path);
        this.db.prepare("UPDATE projects SET updated_at=? WHERE project_id=?").run(Date.now(), id);
      }
      return requireProject(this.db, id);
    });
  }

  deleteProject(id: string): void {
    this.db
      .prepare(
        "UPDATE projects SET deleted=1,deleted_at=?,updated_at=? WHERE project_id=? AND deleted=0 AND host_id=?",
      )
      .run(Date.now(), Date.now(), id, this.ownerHostId ?? "local");
  }

  readProjectTaskRefs(id: string): Array<ProjectTaskRef & { cwd: string }> {
    return this.db
      .prepare("SELECT * FROM tasks WHERE project_id=? AND host_id=? ORDER BY task_id")
      .all(id, this.ownerHostId ?? "local")
      .map((row) => ({
        taskId: String(row.task_id),
        workspacePath: String(row.workspace_path),
        ...(row.workspace_identity == null
          ? {}
          : { workspaceIdentity: String(row.workspace_identity) }),
        cwd: String(row.root_path ?? row.workspace_path),
      }));
  }

  readTaskDirectories(): Array<{ projectId: string | null; cwd: string }> {
    return this.db
      .prepare(
        "SELECT DISTINCT project_id, coalesce(root_path, workspace_path) AS cwd FROM tasks WHERE host_id=? AND deleted=0",
      )
      .all(this.ownerHostId ?? "local")
      .map((row) => ({
        projectId: row.project_id == null ? null : String(row.project_id),
        cwd: String(row.cwd),
      }));
  }

  purgeTasks(tasks: readonly ProjectTaskRef[]): void {
    const host = this.ownerHostId ?? "local";
    // 分组准入表只在新版本库里存在；旧库或测试库缺表时没有可删的行。
    const admissions = tableExists(this.db, "task_group_admissions");
    transaction(this.db, () => {
      for (const task of tasks) {
        const key = resolveWorkspaceKey(task);
        const row = readTask(this.db, task);
        if (row && row.host_id !== host) continue;
        this.db
          .prepare("DELETE FROM tasks WHERE workspace_key=? AND task_id=?")
          .run(key, task.taskId);
        this.db
          .prepare("DELETE FROM task_group_members WHERE workspace_key=? AND task_id=?")
          .run(key, task.taskId);
        if (admissions)
          this.db
            .prepare("DELETE FROM task_group_admissions WHERE workspace_key=? AND task_id=?")
            .run(key, task.taskId);
      }
    });
  }

  markTasksDeleted(tasks: readonly ProjectTaskRef[]): void {
    const host = this.ownerHostId ?? "local";
    transaction(this.db, () => {
      for (const task of tasks)
        this.db
          .prepare(
            "UPDATE tasks SET deleted=1,cli_deleted=1,handoff_pending=handoff_pending & ~1 WHERE workspace_key=? AND task_id=? AND host_id=?",
          )
          .run(resolveWorkspaceKey(task), task.taskId, host);
    });
  }

  purgeProjectIfUnreferenced(id: string): boolean {
    return transaction(this.db, () => {
      const project = readProjects(this.db).find((entry) => entry.id === id);
      if (!project?.deleted || project.hostId !== (this.ownerHostId ?? "local")) return false;
      // 被保留的运行中会话、定时与闲时定义仍指向它时保持软删除：删掉会让它们指向不存在的项目。
      const referenced = ["tasks", "automations", "off_peak_tasks"].some(
        (table) =>
          this.db.prepare(`SELECT 1 FROM ${table} WHERE project_id=? LIMIT 1`).get(id) !==
          undefined,
      );
      if (referenced) return false;
      this.db.prepare("DELETE FROM project_roots WHERE project_id=?").run(id);
      this.db.prepare("DELETE FROM projects WHERE project_id=?").run(id);
      return true;
    });
  }

  hasProjectWorkspace(workspace: { workspacePath: string; workspaceIdentity?: string }): boolean {
    const host = this.ownerHostId ?? "local";
    // 默认任务迁移会清空任务归属，但保留已软删项目的 roots；只有活跃 root 能单独证明归属。
    // 用户删除项目后保留的任务仍由下方 project_id 判定，不能被重新划进共享池。
    return Boolean(
      this.db
        .prepare(`SELECT 1 FROM project_roots r JOIN projects p ON p.project_id=r.project_id
      WHERE p.host_id=? AND p.deleted=0 AND r.root_path=?
      UNION ALL SELECT 1 FROM tasks WHERE host_id=? AND workspace_key=? AND project_id IS NOT NULL LIMIT 1`)
        .get(host, workspace.workspacePath, host, resolveWorkspaceKey(workspace)),
    );
  }

  moveTask(input: { task: ProjectTaskRef; projectId: string; addMissingRoot?: boolean }): void {
    transaction(this.db, () => {
      const project = requireProject(this.db, input.projectId);
      if (project.deleted) throw new Error("project.deleted");
      const task = readTask(this.db, input.task);
      if (!task) throw new Error("project.task-not-found");
      if (project.hostId !== (this.ownerHostId ?? "local") || task.host_id !== project.hostId)
        throw new Error("project.cross-host-move");
      assertRemoteTaskDirectories(this.ownerHostId, project, String(task.root_path));
      if (!project.roots.some((root) => root.rootPath === task.root_path)) {
        if (!input.addMissingRoot) throw new Error("project.root-confirmation-required");
        this.db
          .prepare(
            "INSERT INTO project_roots(project_id,root_path,position,is_primary) VALUES(?,?,?,?)",
          )
          .run(
            project.id,
            String(task.root_path),
            project.roots.length,
            project.roots.length === 0 ? 1 : 0,
          );
      }
      this.db
        .prepare(
          "UPDATE tasks SET project_id=?,handoff_pending=handoff_pending | ? WHERE workspace_key=? AND task_id=?",
        )
        .run(project.id, OWNERSHIP_DECIDED, resolveWorkspaceKey(input.task), input.task.taskId);
    });
  }

  reorderProjects(ids: string[]): void {
    transaction(this.db, () => {
      if (new Set(ids).size !== ids.length) throw new Error("project.duplicate-order");
      ids.forEach((id, position) => {
        if (requireProject(this.db, id).hostId !== (this.ownerHostId ?? "local"))
          throw new Error("project.cross-host-move");
        this.db.prepare("UPDATE projects SET position=? WHERE project_id=?").run(position, id);
      });
    });
  }

  resolveSessionDirectories(task: ProjectTaskRef): ProjectDirectories {
    return transaction(this.db, () => resolveDirectories(this.db, task, this.ownerHostId), false);
  }

  reserveCreatedTask(
    input: Parameters<ProjectRepositoryContract["reserveCreatedTask"]>[0],
  ): ProjectDirectories & { taskId: string } {
    return reserveProjectTask(this.db, this.ownerHostId, input);
  }
}
