import type { DatabaseSync } from "node:sqlite";

// 同步 constructor 只能接已完成 startup 的库；账本全齐也必须拒绝缺失当前使用的结构。
const requiredColumns: Readonly<Record<string, readonly string[]>> = {
  session: ["id", "project_id", "workspace_id", "parent_id", "slug", "directory", "path", "title", "version", "share_url", "summary_additions", "summary_deletions", "summary_files", "summary_diffs", "revert", "permission", "time_compacting", "time_archived", "task_type", "title_source", "title_message_id", "time_title_updated", "trace_id", "time_created", "time_updated"],
  message: ["id", "session_id", "sequence", "data", "time_created", "time_updated"],
  part: ["id", "message_id", "session_id", "sequence", "data", "time_created", "time_updated"],
  todo: ["session_id", "content", "status", "priority", "position", "time_created", "time_updated"],
  session_entry: ["id", "session_id", "type", "data", "time_created", "time_updated"],
  permission: ["project_id", "data", "time_created", "time_updated"],
  input_history: ["id", "project_id", "session_id", "text", "kind", "attachments", "time_created"],
  local_setting: ["scope", "scope_id", "namespace", "key", "value", "schema_version", "time_created", "time_updated"],
  session_target: ["session_id", "target_id", "objective", "status", "token_budget", "tokens_used", "time_used_seconds", "summary_title", "active_input_id", "active_run_started_at", "active_run_last_seen_at", "time_created", "time_updated"],
  workflow_definition: ["id", "name", "scope", "source", "trusted", "enabled", "script_path", "script_hash", "meta_json", "time_created", "time_updated"],
  workflow_run: ["id", "definition_id", "name", "kind", "parent_session_id", "cwd", "script_path", "script_hash", "args_json", "args_hash", "status", "current_phase", "budget_total", "budget_spent", "stats_json", "failure_json", "time_created", "time_started", "time_updated", "time_completed"],
  workflow_activity: ["id", "run_id", "parent_activity_id", "call_index", "call_path", "attempt", "type", "phase", "label", "input_hash", "prompt", "opts_json", "status", "child_session_id", "result_json", "error_json", "time_created", "time_started", "time_updated", "time_completed"],
  workflow_event: ["id", "run_id", "sequence", "type", "phase", "activity_id", "payload_json", "time_created"],
  session_task_link: ["id", "child_session_id", "root_workflow_run_id", "parent_link_id", "activity_id", "parent_session_id", "role", "depth", "path", "phase", "label", "agent_type", "model", "status", "time_created", "time_updated"],
  model_usage: ["id", "logical_request_id", "attempt_index", "session_id", "turn_id", "trace_id", "span_id", "assistant_message_id", "parent_user_message_id", "query_source", "provider_id", "model_id", "variant", "agent", "mode", "task_type", "status", "started_at", "first_token_at", "completed_at", "duration_ms", "time_to_first_token_ms", "finish_reason", "tool_call_count", "input_tokens", "output_tokens", "reasoning_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "provider_total_tokens", "computed_total_tokens", "retry_count", "retryable", "cancelled_by_user", "context_exceeded", "error_type", "error_code", "error_message", "raw_usage_json", "provider_metadata_json"],
  turn_usage: ["session_id", "turn_id", "trace_id", "user_message_id", "status", "started_at", "first_model_start_at", "first_token_at", "completed_at", "duration_ms", "time_to_first_token_ms", "model_request_count", "model_retry_count", "tool_call_count", "tool_error_count", "input_tokens", "output_tokens", "reasoning_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "computed_total_tokens", "retryable", "cancelled_by_user", "context_exceeded", "error_type", "error_code"],
  tool_usage: ["id", "session_id", "turn_id", "trace_id", "tool_call_id", "tool_name", "side_effect_scope", "read_only", "destructive", "approval_status", "status", "started_at", "first_output_at", "completed_at", "duration_ms", "time_to_first_output_ms", "exit_code", "output_bytes", "stdout_bytes", "stderr_bytes", "truncated", "retry_count", "retryable", "cancelled_by_user", "error_type", "error_code", "error_message"],
  session_input: ["id", "session_id", "kind", "delivery", "payload", "admitted_sequence", "promoted_sequence", "promoted_message_id", "status", "status_reason", "time_created", "time_updated"],
  dwf_run: ["id", "parent_session_id", "cwd", "name", "script_text", "script_hash", "args_json", "tool_call_id", "resumed_from", "caps_max_concurrency", "spent_tokens", "status", "result_json", "failure_json", "time_created", "time_updated"],
  dwf_actor: ["id", "run_id", "site_id", "ordinal", "name", "persona_json", "resolved_model", "session_id", "time_created", "time_updated"],
  dwf_node: ["id", "run_id", "site_id", "ordinal", "kind", "actor_site_id", "actor_ordinal", "actor_seq", "input_hash", "input_json", "status", "result_json", "error_json", "stats_json", "message_boundary", "artifact_id", "time_created", "time_updated"],
  dwf_event: ["id", "run_id", "sequence", "type", "payload_json", "time_created"],
};

export function assertSessionDatabaseSchema(db: DatabaseSync): void {
  for (const [table, required] of Object.entries(requiredColumns)) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (required.some((name) => !columns.some((column) => column.name === name))) throw incompatible();
  }
  for (const name of ["message_sequence_autofill", "part_sequence_autofill"])
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name=?").get(name)) throw incompatible();
  const foreignKeys = db.prepare("PRAGMA foreign_key_list(message)").all();
  if (!foreignKeys.some((key) => key.table === "session" && key.from === "session_id" && key.to === "id" && key.on_delete === "CASCADE")) throw incompatible();
}

function incompatible(): Error {
  return Object.assign(new Error("Session storage schema is incompatible with the published migrations"), { kind: "schema_incompatible" });
}
