import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { resolveWorkspaceKey } from "@zcode/shared";
import type { ProjectRepositoryContract, ProjectDirectories } from "./contract.js";
import { ensureHost, OWNERSHIP_DECIDED } from "./legacy-tasks.js";
import { assertRemoteTaskDirectories } from "./remote-policy.js";
import {
  transaction,
  requireProject,
  readTask,
  resolveDirectories,
  executionDirectoriesSchema,
} from "./project-repository-queries.js";

/** 仓库显式传入原连接和持库身份，创建 receipt 与 task 仍在同一事务内提交。 */
export function reserveProjectTask(
  db: DatabaseSync,
  ownerHostId: string | undefined,
  input: Parameters<ProjectRepositoryContract["reserveCreatedTask"]>[0],
): ProjectDirectories & { taskId: string } {
  return transaction(db, () => {
    const key = resolveWorkspaceKey(input.task);
    const host = ensureHost(db, key, ownerHostId);
    if (host !== (ownerHostId ?? "local")) throw new Error("project.cross-host-move");
    const command = input.creationCommand;
    const receipt = command
      ? db
          .prepare(
            "SELECT session_id FROM session_creation_commands WHERE workspace_key=? AND client_id=? AND command_id=?",
          )
          .get(key, command.clientId, command.commandId)
      : undefined;
    let taskId = input.task.taskId;
    if (receipt) {
      if (taskId !== undefined && taskId !== receipt.session_id)
        throw new Error("project.creation-id-conflict");
      taskId = String(receipt.session_id);
      if (!readTask(db, { ...input.task, taskId }))
        throw new Error("project.creation-task-missing");
    } else if (taskId === undefined && command) {
      // 3.16 的旧命令可能已落库；哈希只用于精确查旧行，绝不分配新的 session_ ID。
      const legacyId = `session_${createHash("sha256")
        .update(JSON.stringify([key, command.clientId, command.commandId]))
        .digest("hex")
        .slice(0, 32)}`;
      if (readTask(db, { ...input.task, taskId: legacyId })) taskId = legacyId;
    }
    const task = { ...input.task, taskId: taskId ?? `sess_${randomUUID()}` };
    if (!readTask(db, task)) {
      assertRemoteTaskDirectories(
        ownerHostId,
        input.projectId ? requireProject(db, input.projectId) : null,
        task.workspacePath,
        input.additionalDirectories,
      );
      if (input.projectId) {
        const project = requireProject(db, input.projectId);
        if (project.deleted && input.additionalDirectories === undefined)
          throw new Error("project.deleted");
        if (project.hostId !== host) throw new Error("project.cross-host-move");
        if (
          input.additionalDirectories === undefined &&
          !project.roots.some((root) => root.rootPath === task.workspacePath)
        )
          throw new Error("project.cwd-not-in-roots");
      }
      // 创建归属必须先于 CLI 首发；空事实不是假会话，列表只读取已有 CLI 事实的行。
      db.prepare(`INSERT INTO tasks(workspace_key,workspace_path,workspace_identity,task_id,created_at,updated_at,host_id,root_path,project_id,handoff_pending,execution_directories)
          VALUES(?,?,?,?,0,0,?,?,?,?,?)`).run(
        key,
        task.workspacePath,
        task.workspaceIdentity ?? null,
        task.taskId,
        host,
        task.workspacePath,
        input.projectId,
        OWNERSHIP_DECIDED,
        input.additionalDirectories === undefined
          ? null
          : JSON.stringify(executionDirectoriesSchema.parse(input.additionalDirectories)),
      );
    }
    const directories = resolveDirectories(db, task, ownerHostId);
    // 旧客户端重试发生在 CLI 去重之前；同事务记录首次分配，避免产生额外任务预留。
    if (command && !receipt) {
      db.prepare(
        "INSERT INTO session_creation_commands(workspace_key,client_id,command_id,session_id) VALUES(?,?,?,?)",
      ).run(key, command.clientId, command.commandId, task.taskId);
    }
    return { ...directories, taskId: task.taskId };
  });
}
