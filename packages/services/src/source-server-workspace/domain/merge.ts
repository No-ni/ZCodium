import { WorkspaceAliasError, type WorkspaceAliasCollision } from "../contract.js";
import { matchingWorkspacePath } from "./identity.js";
import {
  field,
  setField,
  table,
  textField,
  type Cell,
  type HashPort,
  type MergeOutput,
  type WorkspaceInspection,
} from "./images.js";

const HOST_KEY_TABLES = [
  "tasks",
  "task_group_members",
  "task_group_workspace_bootstraps",
  "automations",
  "automation_runs",
  "off_peak_tasks",
];
export interface DerivedMerge {
  output: MergeOutput;
  collisions: WorkspaceAliasCollision[];
  blocks: Array<{ code: "active-owner" | "state-diverged"; subject: string }>;
}
const activeOwner = (subject: string): DerivedMerge["blocks"][number] => ({
  code: "active-owner",
  subject,
});
function taskOrder(value: string | null): [string, string] | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) &&
      parsed.length === 2 &&
      parsed.every((item) => typeof item === "string")
      ? (parsed as [string, string])
      : null;
  } catch {
    return null;
  }
}
export function rowWorkspaceKey(
  row: Cell[],
  name: string,
  input: WorkspaceInspection,
): string | null {
  const layout = table(input.host, name)!;
  if (name === "task_group_view_node_orders")
    return textField(row, layout, "node_type") === "task"
      ? (taskOrder(textField(row, layout, "node_key"))?.[0] ?? null)
      : null;
  return textField(row, layout, "workspace_key");
}
export function candidateKeys(input: WorkspaceInspection): string[] {
  const found = new Set<string>();
  for (const layout of input.host.tables)
    for (const row of layout.rows) {
      if (!HOST_KEY_TABLES.includes(layout.name) && layout.name !== "task_group_view_node_orders")
        continue;
      const key = rowWorkspaceKey(row, layout.name, input);
      if (key && input.allowedKeys.includes(key)) found.add(key);
    }
  const sessions = table(input.cli, "session");
  for (const row of sessions?.rows ?? []) {
    const key = textField(row, sessions!, "workspace_id");
    if (key && input.allowedKeys.includes(key)) found.add(key);
  }
  for (const config of input.configs) if (config.exists) found.add(config.workspaceKey);
  return [...found].sort();
}
export function deriveMerge(
  input: WorkspaceInspection,
  canonicalKey: string,
  candidates: readonly string[],
  hash: HashPort,
  choices: ReadonlyMap<string, string> = new Map(),
): DerivedMerge {
  if (!input.allowedKeys.includes(canonicalKey)) throw new WorkspaceAliasError("boundary-rejected");
  const output: MergeOutput = {
    host: structuredClone(input.host),
    cli: structuredClone(input.cli),
    configs: structuredClone(input.configs),
  };
  // 单已有变体只发布别名，不能为换线路重写旧记录或运行中 owner；无旧数据同样零改写。
  if (candidates.length <= 1) return { output, collisions: [], blocks: [] };
  const collisions: WorkspaceAliasCollision[] = [];
  const blocks: DerivedMerge["blocks"] = [];
  const sources = new Set(candidates);
  const choose = (
    kind: WorkspaceAliasCollision["kind"],
    subject: string,
    rows: Array<{ key: string; row: Cell[]; original: Cell[] }>,
  ): Cell[] => {
    const collision: WorkspaceAliasCollision = {
      collisionId: hash.hash({
        kind,
        subject,
        rows: rows.map((value) => ({ key: value.key, hash: hash.hash(value.original) })),
      }),
      kind,
      subject,
      sources: rows.map((value) => ({
        workspaceKey: value.key,
        valueHash: hash.hash(value.original),
      })),
    };
    collisions.push(collision);
    const picked = choices.get(collision.collisionId);
    return rows.find((value) => value.key === picked)?.row ?? rows[0]!.row;
  };
  for (const layout of output.host.tables) {
    if (!HOST_KEY_TABLES.includes(layout.name) && layout.name !== "task_group_view_node_orders")
      continue;
    const original = table(input.host, layout.name)!;
    const buckets = new Map<string, Array<{ key: string; row: Cell[]; original: Cell[] }>>();
    const unrelated: Cell[][] = [];
    for (let index = 0; index < layout.rows.length; index++) {
      const row = layout.rows[index]!;
      const before = original.rows[index]!;
      const key = rowWorkspaceKey(before, layout.name, input);
      if (!key || !sources.has(key)) {
        unrelated.push(row);
        continue;
      }
      const workspacePath = textField(before, layout, "workspace_path");
      if (
        workspacePath !== null &&
        !matchingWorkspacePath(workspacePath, input.scope.workspacePath, input.allowedKeys)
      ) {
        blocks.push({ code: "state-diverged", subject: `${layout.name}:${key}` });
        unrelated.push(row);
        continue;
      }
      if (layout.name === "tasks") {
        const status = textField(row, layout, "task_status");
        if (["running", "busy", "pending", "streaming"].includes(status ?? ""))
          blocks.push(activeOwner(`task:${textField(row, layout, "task_id")}`));
        const meta = textField(row, layout, "meta_json");
        if (meta !== null) {
          try {
            const parsed: unknown = JSON.parse(meta);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
            const record = parsed as Record<string, unknown>;
            if (
              typeof record.workspaceIdentity === "string" &&
              sources.has(record.workspaceIdentity)
            )
              record.workspaceIdentity = canonicalKey;
            if (typeof record.workspacePath === "string" && sources.has(record.workspacePath))
              record.workspacePath = input.scope.workspacePath;
            if (["running", "busy", "pending", "streaming"].includes(String(record.status ?? "")))
              blocks.push(activeOwner(`task:${textField(row, layout, "task_id")}`));
            setField(row, layout, "meta_json", JSON.stringify(record));
          } catch {
            blocks.push({
              code: "state-diverged",
              subject: `task-meta:${textField(row, layout, "task_id")}`,
            });
          }
        }
      }
      if (
        layout.name === "automations" &&
        (Number(field(row, layout, "running")) ||
          Number(field(row, layout, "claimed_at")) ||
          textField(row, layout, "dispatch_status") === "claimed")
      )
        blocks.push(activeOwner(`automation:${textField(row, layout, "automation_id")}`));
      if (
        layout.name === "automation_runs" &&
        (textField(row, layout, "dispatch_status") === "claimed" ||
          textField(row, layout, "outcome") === "running")
      )
        blocks.push(activeOwner(`automation-run:${textField(row, layout, "run_id")}`));
      if (
        layout.name === "off_peak_tasks" &&
        (Number(field(row, layout, "claim_running")) ||
          Number(field(row, layout, "claimed_at")) ||
          ["running", "queued", "submitted", "pending"].includes(
            textField(row, layout, "status") ?? "",
          ))
      )
        blocks.push(activeOwner(`off-peak:${textField(row, layout, "off_peak_task_id")}`));
      if (layout.name === "task_group_view_node_orders") {
        const order = taskOrder(textField(row, layout, "node_key"))!;
        setField(row, layout, "node_key", JSON.stringify([canonicalKey, order[1]]));
      } else {
        setField(row, layout, "workspace_key", canonicalKey);
        setField(row, layout, "workspace_identity", canonicalKey);
        if (workspacePath && sources.has(workspacePath))
          setField(row, layout, "workspace_path", input.scope.workspacePath);
      }
      const primary = layout.primaryKey.length ? layout.primaryKey : ["off_peak_task_id"];
      let collisionKey = hash.hash(primary.map((name) => field(row, layout, name)));
      if (
        layout.name === "off_peak_tasks" &&
        textField(row, layout, "session_id") &&
        !["completed", "failed", "cancelled"].includes(textField(row, layout, "status") ?? "")
      )
        collisionKey = hash.hash([canonicalKey, field(row, layout, "session_id")]);
      const bucket = buckets.get(collisionKey) ?? [];
      bucket.push({ key, row, original: before });
      buckets.set(collisionKey, bucket);
    }
    const merged: Cell[][] = [];
    for (const bucket of buckets.values()) {
      if (bucket.length === 1) {
        merged.push(bucket[0]!.row);
        continue;
      }
      const kind =
        layout.name === "tasks"
          ? "task"
          : layout.name === "task_group_members"
            ? "member"
            : layout.name === "task_group_view_node_orders"
              ? "order"
              : "bootstrap";
      const subject = `${layout.name}:${textField(bucket[0]!.row, layout, "task_id") ?? textField(bucket[0]!.row, layout, "workspace_key") ?? "binding"}`;
      const selected = choose(kind, subject, bucket);
      if (kind === "task") {
        const sessions = table(input.cli, "session");
        const taskId = textField(selected, layout, "task_id");
        const session = sessions?.rows.find((row) => textField(row, sessions!, "id") === taskId);
        const sessionOwner = session && textField(session, sessions!, "workspace_id");
        const selectedOwner = bucket.find((value) => value.row === selected)!.key;
        if (
          sessionOwner &&
          sessionOwner !== selectedOwner &&
          // 预检尚未选来源时不能把可行选择变成硬阻断；确认才校验选定来源与CLI既有owner一致。
          (choices.has(collisions.at(-1)!.collisionId) || !sources.has(sessionOwner))
        )
          blocks.push({ code: "state-diverged", subject: `task-session-owner:${taskId}` });
      }
      merged.push(selected);
    }
    layout.rows = [...unrelated, ...merged];
  }
  deriveCli(input, output, canonicalKey, sources, blocks);
  for (const root of new Set(output.configs.map((config) => config.root))) {
    const configs = output.configs.filter(
      (config) => config.root === root && sources.has(config.workspaceKey),
    );
    const canonical = output.configs.find(
      (config) => config.root === root && config.workspaceKey === canonicalKey,
    );
    if (!canonical) continue;
    const entries = new Map<
      string,
      Array<{ key: string; entry: (typeof canonical.entries)[number] }>
    >();
    for (const config of configs)
      for (const entry of config.entries) {
        const values = entries.get(entry.path) ?? [];
        values.push({ key: config.workspaceKey, entry });
        entries.set(entry.path, values);
      }
    canonical.entries = [];
    canonical.exists = configs.some((config) => config.exists);
    for (const [path, values] of entries) {
      if (new Set(values.map((value) => `${value.entry.kind}:${value.entry.hash}`)).size > 1) {
        const collision: WorkspaceAliasCollision = {
          collisionId: hash.hash({
            root,
            path,
            values: values.map((value) => ({ key: value.key, hash: value.entry.hash })),
          }),
          kind: "config",
          subject: `${root}/${path}`,
          sources: values.map((value) => ({
            workspaceKey: value.key,
            valueHash: value.entry.hash,
          })),
        };
        collisions.push(collision);
        canonical.entries.push(
          values.find((value) => value.key === choices.get(collision.collisionId))?.entry ??
            values[0]!.entry,
        );
      } else canonical.entries.push(values[0]!.entry);
    }
    // 选择文件意味着显式舍弃同路径目录子树，否则备份阶段会尝试在文件下mkdir并留下不可重入半成品。
    const files = new Set(
      canonical.entries.filter((entry) => entry.kind === "file").map((entry) => entry.path),
    );
    canonical.entries = canonical.entries
      .filter((entry) => {
        const segments = entry.path.split("/");
        return !segments
          .slice(0, -1)
          .some((_, index) => files.has(segments.slice(0, index + 1).join("/")));
      })
      .sort((left, right) => left.path.localeCompare(right.path));
    for (const config of configs)
      if (config !== canonical) {
        config.exists = false;
        config.entries = [];
      }
  }
  return { output, collisions, blocks };
}
function deriveCli(
  input: WorkspaceInspection,
  output: MergeOutput,
  canonical: string,
  sources: ReadonlySet<string>,
  blocks: DerivedMerge["blocks"],
): void {
  const sessions = table(output.cli, "session");
  if (!sessions) return;
  const tasks = table(input.host, "tasks");
  const taskOwners = new Map<string, Set<string>>();
  for (const row of tasks?.rows ?? []) {
    const key = textField(row, tasks!, "workspace_key");
    const id = textField(row, tasks!, "task_id");
    if (key && id && sources.has(key)) {
      const owners = taskOwners.get(id) ?? new Set();
      owners.add(key);
      taskOwners.set(id, owners);
    }
  }
  const adopted = new Set<string>();
  for (const row of sessions.rows) {
    const rawKey = field(row, sessions, "workspace_id");
    let key = textField(row, sessions, "workspace_id");
    const id = textField(row, sessions, "id")!;
    const directory = textField(row, sessions, "directory");
    const path = textField(row, sessions, "path");
    if (taskOwners.has(id) && rawKey !== null && (!key || !sources.has(key))) {
      blocks.push({ code: "state-diverged", subject: `task-session-owner:${id}` });
      continue;
    }
    if (
      rawKey === null &&
      taskOwners.has(id) &&
      matchingWorkspacePath(directory, input.scope.workspacePath, input.allowedKeys)
    ) {
      const owners = taskOwners.get(id)!;
      if (owners.size !== 1) {
        blocks.push({ code: "state-diverged", subject: `unclaimed-session:${id}` });
        continue;
      }
      key = [...owners][0]!;
    }
    if (!key || !sources.has(key)) continue;
    if (
      !matchingWorkspacePath(directory, input.scope.workspacePath, input.allowedKeys) ||
      (path !== null && !matchingWorkspacePath(path, input.scope.workspacePath, input.allowedKeys))
    ) {
      blocks.push({ code: "state-diverged", subject: `session:${id}` });
      continue;
    }
    adopted.add(id);
    setField(row, sessions, "workspace_id", canonical);
    if (directory && sources.has(directory)) {
      setField(row, sessions, "directory", input.scope.workspacePath);
      setField(row, sessions, "project_id", input.projectId);
    }
    if (path && sources.has(path)) setField(row, sessions, "path", input.scope.workspacePath);
  }
  const targets = table(input.cli, "session_target");
  for (const row of targets?.rows ?? [])
    if (
      adopted.has(textField(row, targets!, "session_id") ?? "") &&
      (field(row, targets!, "active_input_id") != null ||
        field(row, targets!, "active_run_started_at") != null ||
        field(row, targets!, "active_run_last_seen_at") != null)
    )
      blocks.push({
        code: "active-owner",
        subject: `session-target:${textField(row, targets!, "session_id")}`,
      });
  for (const name of [
    "session_input",
    "model_usage",
    "turn_usage",
    "tool_usage",
    "workflow_run",
    "dwf_run",
  ]) {
    const layout = table(input.cli, name);
    if (!layout) continue;
    for (const row of layout.rows) {
      const session =
        textField(row, layout, "session_id") ?? textField(row, layout, "parent_session_id");
      if (
        session &&
        adopted.has(session) &&
        ["admitted", "running", "pending", "queued"].includes(
          textField(row, layout, "status") ?? "",
        )
      )
        blocks.push({ code: "active-owner", subject: `${name}:${session}` });
    }
  }
}
