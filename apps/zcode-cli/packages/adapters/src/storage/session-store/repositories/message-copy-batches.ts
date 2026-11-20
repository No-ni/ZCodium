import type { DatabaseSync } from "node:sqlite";
import { type SessionId } from "@zcode/contracts";

const COPY_BATCH_SIZE = 128;

const JSON_EDIT_BATCH_SIZE = 128;

type JsonObject = Record<string, unknown>;

interface Changes {
  remove: string[];
  set: string[];
  values: unknown[];
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// 比较同一份轻量投影的克隆前后值，只改引用/可见性等真实差异。不能用 merge-patch：
// 它会删除显式 null，也不能用全量 JSON 覆盖：那会丢失未读出的正文与旧版快照字段。
function diffJson(before: unknown, after: unknown, path: string, changes: Changes): void {
  if (before === after) return;
  if (isObject(before) && isObject(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      diffJson(before[key], after[key], `${path}.${JSON.stringify(key)}`, changes);
    }
  } else if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    // orderedMessageIds 可包含整个长对话。标量数组整体改写，避免每个 ID 占一个
    // JSON 函数参数；附件对象仍逐字段改写，保留投影时省略的 URL/正文。
    if (after.every((value) => value === null || typeof value !== "object")) {
      if (after.some((value, index) => value !== before[index])) {
        changes.set.push(path);
        changes.values.push(after);
      }
      return;
    }
    before.forEach((value, index) => diffJson(value, after[index], `${path}[${index}]`, changes));
  } else if (after === undefined) {
    changes.remove.push(path);
  } else {
    changes.set.push(path);
    changes.values.push(after);
  }
}

interface CopyRow {
  source: string;
  id: string;
  messageId?: string;
  created: number;
  updated: number;
  sequence: number;
  values: unknown[];
}

interface CopyGroup {
  changes: Changes;
  rows: CopyRow[];
}

function addCopy(
  groups: Map<string, CopyGroup>,
  before: object,
  after: object,
  row: Omit<CopyRow, "values">,
): void {
  const changes: Changes = { remove: [], set: [], values: [] };
  const dataOnly = (value: object) => {
    const { id: _id, sessionID: _sessionID, messageID: _messageID, ...data } = value as JsonObject;
    return data;
  };
  diffJson(dataOnly(before), dataOnly(after), "$", changes);
  const key = JSON.stringify([changes.remove, changes.set]);
  const group = groups.get(key) ?? { changes, rows: [] };
  group.rows.push({ ...row, values: changes.values });
  groups.set(key, group);
}

function insertCopies(
  db: DatabaseSync,
  table: "message" | "part",
  groups: Map<string, CopyGroup>,
  parent: SessionId,
  child: SessionId,
): void {
  for (const { changes, rows } of groups.values()) {
    let data = "source.data";
    for (let offset = 0; offset < changes.remove.length; offset += JSON_EDIT_BATCH_SIZE) {
      data = `json_remove(${data}, ${changes.remove
        .slice(offset, offset + JSON_EDIT_BATCH_SIZE)
        .map(() => "?")
        .join(",")})`;
    }
    for (let offset = 0; offset < changes.set.length; offset += JSON_EDIT_BATCH_SIZE) {
      data = `json_set(${data}, ${changes.set
        .slice(offset, offset + JSON_EDIT_BATCH_SIZE)
        .map((_, index) => `?, json(plan.value -> '$.values[${offset + index}]')`)
        .join(",")})`;
    }
    // 普通 JOIN 会被 SQLite 排成 source 在外层，每批重复扫描整个父会话，退化为平方级。
    // CROSS JOIN 固定 plan 在外层，每个复制项只按源记录主键查询一次。
    const statement = db.prepare(`
      insert into ${table} (id, session_id, ${table === "part" ? "message_id," : ""} time_created, time_updated, sequence, data)
      select json_extract(plan.value, '$.id'), ?, ${table === "part" ? "json_extract(plan.value, '$.messageId')," : ""}
        json_extract(plan.value, '$.created'), json_extract(plan.value, '$.updated'), json_extract(plan.value, '$.sequence'), ${data}
      from json_each(?) plan cross join ${table} source on source.id = json_extract(plan.value, '$.source')
      where source.session_id = ?
    `);
    for (let index = 0; index < rows.length; index += COPY_BATCH_SIZE) {
      const batch = rows.slice(index, index + COPY_BATCH_SIZE);
      const result = statement.run(
        child,
        ...changes.remove,
        ...changes.set,
        JSON.stringify(batch),
        parent,
      );
      if (Number(result.changes) !== batch.length) throw new Error("Fork copy source missing");
    }
  }
}
export {
  COPY_BATCH_SIZE,
  JSON_EDIT_BATCH_SIZE,
  type JsonObject,
  type Changes,
  isObject,
  diffJson,
  type CopyRow,
  type CopyGroup,
  addCopy,
  insertCopies,
};
