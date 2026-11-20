import type { DatabaseSync } from "node:sqlite";
import { resolveWorkspaceKey } from "@zcode/shared";
import type { ProjectTaskRef } from "#src/project-storage/contract.js";
import { OWNERSHIP_DECIDED } from "#src/project-storage/legacy-tasks.js";
import { assertRemoteTaskDirectories } from "#src/project-storage/remote-policy.js";
import { transaction, requireProject, readTask } from "./project-repository-queries.js";
export function moveProjectTask(
  db: DatabaseSync,
  ownerHostId: string | undefined,
  input: { task: ProjectTaskRef; projectId: string; addMissingRoot?: boolean },
): void {
  transaction(db, () => {
    const project = requireProject(db, input.projectId);
    if (project.deleted) throw new Error("project.deleted");
    const task = readTask(db, input.task);
    if (!task) throw new Error("project.task-not-found");
    if (project.hostId !== (ownerHostId ?? "local") || task.host_id !== project.hostId)
      throw new Error("project.cross-host-move");
    // worktree 任务的 cwd 在受管根目录下，移动会把 worktree 路径变成别的项目的 root（§7.1）。
    if (typeof task.worktree_root === "string") throw new Error("project.worktree-task-immovable");
    assertRemoteTaskDirectories(ownerHostId, project, String(task.root_path));
    if (!project.roots.some((root) => root.rootPath === task.root_path)) {
      if (!input.addMissingRoot) throw new Error("project.root-confirmation-required");
      db.prepare(
        "INSERT INTO project_roots(project_id,root_path,position,is_primary) VALUES(?,?,?,?)",
      ).run(
        project.id,
        String(task.root_path),
        project.roots.length,
        project.roots.length === 0 ? 1 : 0,
      );
    }
    db.prepare(
      "UPDATE tasks SET project_id=?,handoff_pending=handoff_pending | ? WHERE workspace_key=? AND task_id=?",
    ).run(project.id, OWNERSHIP_DECIDED, resolveWorkspaceKey(input.task), input.task.taskId);
  });
}
