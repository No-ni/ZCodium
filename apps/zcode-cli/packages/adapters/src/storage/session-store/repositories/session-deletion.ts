import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type SessionId,
  type SessionTaskType,
  type SessionDeletionSnapshot,
  type SessionDeletionReference,
} from "@zcode/contracts";

/**
 * 只沿「附属会话」展开后代：subagent / workflow / 侧边问答的子会话随父会话存在。
 * fork 的 parent_id 也指向源会话，但它是用户可见的独立任务（可能已归入别的项目），
 * 删除源会话时绝不能连带删除；interactive / workflow_parent 同理不展开。
 */
const OWNED_CHILD_TASK_TYPES: readonly SessionTaskType[] = [
  "selection_side_chat",
  "workflow_child",
  "subagent_child",
  "nested_workflow_child",
];

const SQL_ID_CHUNK = 400;

function chunked<T>(items: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += SQL_ID_CHUNK)
    chunks.push(items.slice(index, index + SQL_ID_CHUNK));
  return chunks;
}

/** 每个根会话 → 根自身与全部附属后代；根不存在时返回空数组。 */
export function listOwnedSessionTrees(
  db: DatabaseSync,
  sessionIDs: readonly SessionId[],
): Map<SessionId, SessionId[]> {
  const exists = db.prepare("select 1 from session where id = ?");
  const children = db.prepare(
    `select id from session where parent_id = ? and task_type in (${OWNED_CHILD_TASK_TYPES.map(() => "?").join(",")})
     union select child_session_id as id from session_task_link where parent_session_id = ?`,
  );
  const trees = new Map<SessionId, SessionId[]>();
  for (const root of sessionIDs) {
    if (!exists.get(root)) {
      trees.set(root, []);
      continue;
    }
    const seen = new Set<SessionId>([root]);
    const queue = [root];
    while (queue.length) {
      const current = queue.shift()!;
      for (const row of children.all(current, ...OWNED_CHILD_TASK_TYPES, current) as Array<{
        id: SessionId;
      }>) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        queue.push(row.id);
      }
    }
    trees.set(root, [...seen]);
  }
  return trees;
}

/**
 * 彻底删除会话及其附属后代的全部行。message/part/todo/usage 等经外键级联；
 * input_history、dwf_run、workflow_run 对 session 没有级联外键，必须显式删除，否则留下孤儿行。
 * 调用方负责先删除会话文件：文件失败时不调用本函数，下次重试仍能按会话找到它们。
 */
export function purgeSessions(db: DatabaseSync, sessionIDs: readonly SessionId[]): void {
  const ids = [...new Set([...listOwnedSessionTrees(db, sessionIDs).values()].flat())];
  if (!ids.length) return;
  // foreign_keys 不能在事务内切换；启动时已打开，这里再保证一次级联生效。
  db.exec("pragma foreign_keys = on");
  db.exec("begin immediate");
  try {
    for (const chunk of chunked(ids)) {
      const marks = chunk.map(() => "?").join(",");
      db.prepare(`delete from input_history where session_id in (${marks})`).run(...chunk);
      db.prepare(`delete from dwf_run where parent_session_id in (${marks})`).run(...chunk);
      db.prepare(`delete from workflow_run where parent_session_id in (${marks})`).run(...chunk);
      db.prepare(`delete from session where id in (${marks})`).run(...chunk);
    }
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

/** 所有进程共享删除屏障。进程存在但状态不明时保守拒绝，不用超时猜它已经退出。 */
export function inspectSessionDeletion(
  db: DatabaseSync,
  root: SessionId,
  ownerId: string,
): SessionDeletionSnapshot {
  const receipt = db
    .prepare(
      "select session_id,retained_artifacts,state from session_purge where root_id=? order by session_id",
    )
    .all(root) as Array<{ session_id: SessionId; retained_artifacts: string; state: string }>;
  const ids = receipt.length
    ? receipt.map((row) => row.session_id)
    : (listOwnedSessionTrees(db, [root]).get(root) ?? []);
  const inside = new Set<string>(ids);
  const forks: SessionDeletionSnapshot["forks"] = [];
  if (ids.length)
    for (const row of db
      .prepare(
        "select id as sessionId,title,parent_id from session where time_deleted is null order by id",
      )
      .iterate() as Iterable<{ sessionId: SessionId; title: string; parent_id: string | null }>) {
      if (row.parent_id && inside.has(row.parent_id) && !inside.has(row.sessionId))
        forks.push({ sessionId: row.sessionId, title: row.title });
    }
  const references = new Map<string, SessionDeletionReference>();
  // 引用可能藏在旧分支、输入队列、工具结果或工作流元数据，不能只按 fork 谱系查。
  const sources = [
    ["part", "session_id", "data"],
    ["message", "session_id", "data"],
    ["session_input", "session_id", "payload"],
    ["session_entry", "session_id", "data"],
    ["session", "id", "revert"],
    ["input_history", "session_id", "attachments"],
  ] as const;
  const queries = sources.map(
    ([table, id, data]) =>
      `select t.${id} as session_id,t.${data} as body,s.title from ${table} t join session s on s.id=t.${id} where s.time_deleted is null and instr(t.${data}, 'zcode-artifact://')>0`,
  );
  // 工作流 journal 里的产物不一定进入消息 part，必须沿 run 的会话归属检查。
  for (const [table, owner, columns] of [
    ["dwf_run", null, ["args_json", "result_json", "failure_json"]],
    ["workflow_run", null, ["args_json", "stats_json", "failure_json"]],
    ["dwf_node", "dwf_run", ["input_json", "result_json", "error_json"]],
    ["dwf_event", "dwf_run", ["payload_json"]],
    ["dwf_actor", "dwf_run", ["persona_json"]],
    ["workflow_activity", "workflow_run", ["prompt", "opts_json", "result_json", "error_json"]],
    ["workflow_event", "workflow_run", ["payload_json"]],
  ] as const) {
    const body = columns.map((column) => `coalesce(t.${column},'')`).join(" || ' ' || ");
    queries.push(
      `select s.id as session_id,${body} as body,s.title from ${table} t ${owner ? `join ${owner} r on r.id=t.run_id` : ""} join session s on s.id=${owner ? "r" : "t"}.parent_session_id where s.time_deleted is null and instr(${body},'zcode-artifact://')>0`,
    );
  }
  for (const query of queries) {
    const rows = db.prepare(query).iterate() as Iterable<{
      session_id: SessionId;
      body: string;
      title: string;
    }>;
    for (const row of rows) {
      if (inside.has(row.session_id)) continue;
      for (const match of row.body.matchAll(/zcode-artifact:\/\/([^/"\\\s]+)\/([^"\\\s/?#]+)/g)) {
        const sessionId = decodeURIComponent(match[1]!) as SessionId;
        const artifactId = decodeURIComponent(match[2]!);
        if (!inside.has(sessionId)) continue;
        const key = `${sessionId}/${artifactId}`;
        const entry = references.get(key) ?? { sessionId, artifactId, referrers: [] };
        if (!entry.referrers.some((ref) => ref.sessionId === row.session_id))
          entry.referrers.push({ sessionId: row.session_id, title: row.title });
        references.set(key, entry);
      }
    }
  }
  if (receipt.length)
    for (const row of receipt)
      for (const artifactId of JSON.parse(row.retained_artifacts) as string[]) {
        const key = `${row.session_id}/${artifactId}`;
        if (!references.has(key))
          references.set(key, { sessionId: row.session_id, artifactId, referrers: [] });
      }
  let foreignRuntime = false;
  const localRuntimeIds: SessionId[] = [];
  for (const row of db
    .prepare("select session_id,owner_id,process_id from session_runtime_presence")
    .all() as Array<{ session_id: string; owner_id: string; process_id: number }>) {
    if (!inside.has(row.session_id)) continue;
    if (row.owner_id === ownerId) {
      localRuntimeIds.push(row.session_id as SessionId);
      continue;
    }
    let alive = true;
    try {
      process.kill(row.process_id, 0);
    } catch (error) {
      alive = (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
    if (alive) foreignRuntime = true;
    else
      db.prepare("delete from session_runtime_presence where session_id=? and owner_id=?").run(
        row.session_id,
        row.owner_id,
      );
  }
  const pendingWork =
    !receipt.length &&
    ids.some((id) =>
      Boolean(
        db
          .prepare("select 1 from session_input where session_id=? and status='admitted' limit 1")
          .get(id) ||
        db
          .prepare("select 1 from session_target where session_id=? and status='active' limit 1")
          .get(id),
      ),
    );
  const orderedReferences = [...references.values()].sort((a, b) =>
    `${a.sessionId}/${a.artifactId}`.localeCompare(`${b.sessionId}/${b.artifactId}`),
  );
  for (const ref of orderedReferences)
    ref.referrers.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  const facts = ids.map((id) =>
    db.prepare("select id,time_updated,time_deleted from session where id=?").get(id),
  );
  const revision = createHash("sha256")
    .update(JSON.stringify({ ids, facts, forks, references: orderedReferences, pendingWork }))
    .digest("hex");
  const workspace =
    db
      .prepare("select directory as path,workspace_id as identity from session where id=?")
      .get(root) ??
    db
      .prepare(
        "select workspace_path as path,workspace_identity as identity from session_purge where session_id=?",
      )
      .get(root);
  return {
    workspacePath: workspace?.path as string | undefined,
    workspaceIdentity: (workspace?.identity ?? undefined) as string | undefined,
    revision,
    sessionIds: ids,
    forks,
    references: orderedReferences,
    foreignRuntime,
    localRuntimeIds,
    pendingWork,
    deleting: receipt.some((row) => row.state === "deleting"),
    completed: receipt.length > 0 && receipt.every((row) => row.state === "deleted"),
  };
}

export function beginSessionDeletion(
  db: DatabaseSync,
  root: SessionId,
  ownerId: string,
  revision: string,
  operationId: string,
  retained: Array<{ sessionId: SessionId; artifactId: string }>,
): void {
  db.exec("begin immediate");
  try {
    const snapshot = inspectSessionDeletion(db, root, ownerId);
    if (snapshot.foreignRuntime || snapshot.pendingWork)
      throw Object.assign(new Error("session-data.running"), { code: "running" });
    if (!snapshot.deleting && !snapshot.completed) {
      if (snapshot.revision !== revision || !snapshot.sessionIds.length)
        throw Object.assign(new Error("session-data.changed"), { code: "changed" });
      const insert = db.prepare(
        "insert into session_purge(session_id,root_id,operation_id,retained_artifacts,workspace_path,workspace_identity,state) values(?,?,?,?,?,?,'deleting')",
      );
      for (const id of snapshot.sessionIds)
        insert.run(
          id,
          root,
          operationId,
          JSON.stringify(
            retained.filter((ref) => ref.sessionId === id).map((ref) => ref.artifactId),
          ),
          snapshot.workspacePath ?? "",
          snapshot.workspaceIdentity ?? null,
        );
    }
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

export function completeSessionDeletion(db: DatabaseSync, root: SessionId): void {
  // 文件已清理后才删除正文。凭据独立于 session，重启和旧 create/upsert 不能复活同一 ID。
  const ids = db
    .prepare("select session_id from session_purge where root_id=?")
    .all(root) as Array<{ session_id: SessionId }>;
  purgeSessions(
    db,
    ids.map((row) => row.session_id),
  );
  db.prepare("update session_purge set state='deleted' where root_id=?").run(root);
}
export { OWNED_CHILD_TASK_TYPES, SQL_ID_CHUNK, chunked };
