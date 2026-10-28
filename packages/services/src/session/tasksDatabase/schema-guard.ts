import type { DatabaseSync } from "node:sqlite";

// ready 账本不能证明库文件没有被替换/删列；只读验收当前持久化合同，绝不隐式修 schema。
const requiredColumns: Readonly<Record<string, readonly string[]>> = {
  tasks: [
    "workspace_key",
    "workspace_path",
    "workspace_identity",
    "task_id",
    "title",
    "task_status",
    "provider",
    "mode",
    "model",
    "migration_source",
    "forked_from_task_id",
    "unread_at",
    "pinned",
    "archived",
    "title_overridden",
    "last_unread_at",
    "searchable_text",
    "cron_automation_id",
    "off_peak_task_id",
    "meta_json",
    "deleted",
    "created_at",
    "updated_at",
  ],
  task_groups: ["group_id", "title", "color", "created_at", "updated_at"],
  task_group_members: [
    "group_id",
    "workspace_key",
    "workspace_path",
    "workspace_identity",
    "task_id",
    "sort_order",
    "added_at",
    "created_at",
    "updated_at",
  ],
  task_group_view_node_orders: ["node_type", "node_key", "sort_order", "created_at", "updated_at"],
  task_group_workspace_bootstraps: ["workspace_key", "group_id", "created_at", "updated_at"],
  automations: [
    "automation_id",
    "title",
    "prompt",
    "cron_expr",
    "model",
    "provider",
    "model_selection",
    "thought_level",
    "workspace_key",
    "workspace_path",
    "workspace_identity",
    "target_task_id",
    "bot_delivery_target",
    "mode",
    "location_kind",
    "recurring",
    "max_runs",
    "end_at",
    "schedule_rule",
    "schedule_edited_by_user",
    "scheduled_run_count",
    "run_count",
    "enabled",
    "lifecycle_status",
    "next_run_at",
    "last_run_at",
    "running",
    "claimed_at",
    "dispatch_status",
    "dispatch_attempts",
    "retry_at",
    "last_error",
    "created_at",
    "updated_at",
  ],
  automation_runs: [
    "run_id",
    "automation_id",
    "workspace_key",
    "scheduled_at",
    "trigger",
    "model_selection",
    "dispatch_status",
    "outcome",
    "session_id",
    "error",
    "attempts",
    "created_at",
    "updated_at",
  ],
  off_peak_tasks: [
    "off_peak_task_id",
    "server_ticket_id",
    "title",
    "conversation_id",
    "workspace_key",
    "workspace_path",
    "workspace_identity",
    "session_id",
    "prompt",
    "permission_mode",
    "model",
    "status",
    "thought_level",
    "model_selection",
    "queued_at",
    "started_at",
    "ended_at",
    "failure_reason",
    "files_changed",
    "settled_at",
    "history_deleted_at",
    "registered_at",
    "schedulable",
    "queue_position",
    "next_poll_at",
    "claim_running",
    "claimed_at",
    "attempt_count",
    "last_error",
    "created_at",
    "updated_at",
  ],
};
const primaryKeys: Readonly<Record<string, readonly string[]>> = {
  tasks: ["workspace_key", "task_id"],
  task_groups: ["group_id"],
  task_group_members: ["workspace_key", "task_id"],
  task_group_view_node_orders: ["node_type", "node_key"],
  task_group_workspace_bootstraps: ["workspace_key"],
  automations: ["automation_id"],
  automation_runs: ["run_id"],
  off_peak_tasks: ["off_peak_task_id"],
};

export function assertTasksDatabaseSchema(db: DatabaseSync): void {
  for (const [table, required] of Object.entries(requiredColumns)) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (required.some((name) => !columns.some((column) => column.name === name)))
      throw incompatible();
    const keys = columns
      .filter((column) => Number(column.pk) > 0)
      .sort((left, right) => Number(left.pk) - Number(right.pk))
      .map((column) => column.name);
    if (JSON.stringify(keys) !== JSON.stringify(primaryKeys[table])) throw incompatible();
  }
  const membership = db.prepare("PRAGMA foreign_key_list(task_group_members)").all();
  if (
    !membership.some(
      (key) =>
        key.table === "task_groups" &&
        key.from === "group_id" &&
        key.to === "group_id" &&
        key.on_delete === "CASCADE",
    )
  )
    throw incompatible();
}

function incompatible(): Error {
  return Object.assign(
    new Error("Task storage schema is incompatible with the published migrations"),
    { kind: "schema_incompatible" },
  );
}
