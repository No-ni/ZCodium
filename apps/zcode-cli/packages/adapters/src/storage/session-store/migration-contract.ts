import type { SqliteMigration } from "@zcode/shared/sqlite-migrations";
import { SQLITE_MIGRATIONS } from "./migrations.js";

// 清单独立于已发布 SQL：添加备份合同不能改变 0001–0023 的 trim SHA-256 或历史 ledger id。
const touchedTables: Readonly<Record<string, readonly string[]>> = {
  "0001_base_session_store": ["session", "message", "part", "todo", "session_entry", "permission", "input_history"],
  "0002_local_setting": ["local_setting"],
  "0003_backfill_permission_local_setting": ["local_setting", "permission"],
  "0004_session_target": ["session_target"],
  "0005_session_target_accounting": ["session_target", "session_target_next"],
  "0006_input_history_attachments": ["input_history"],
  "0007_workflow_script_runtime": ["session", "workflow_definition", "workflow_run", "workflow_activity", "workflow_event", "session_task_link"],
  "0008_workflow_definition_scope": ["workflow_definition"],
  "0009_session_title_metadata": ["session"],
  "0010_usage_observability": ["model_usage", "turn_usage", "tool_usage"],
  "0011_session_target_summary_title": ["session_target"],
  "0012_session_trace_id": ["session"],
  "0013_session_target_active_run_accounting": ["session_target"],
  "0014_message_part_sequence": ["message", "part"],
  "0015_message_part_sequence_backfill_and_guard": ["message", "part"],
  "0016_session_input_ledger": ["session_input"],
  "0017_session_input_start_now_delivery": ["session_input", "session_input_before_start_now"],
  "0018_session_input_failed_status": ["session_input", "session_input_before_failed_status"],
  "0019_dwf_journal": ["dwf_run", "dwf_actor", "dwf_node", "dwf_event"],
  "0020_provider_model_selection": ["message", "part", "session_entry"],
  "0021_official_glm_selection": ["session_entry"],
  "0022_backfilled_session_reasoning": ["session_entry"],
  "0023_repair_invalid_model_selection": ["session_entry"],
};

export const SESSION_DATABASE_MIGRATIONS: readonly SqliteMigration[] = SQLITE_MIGRATIONS.map((step) => {
  const tables = touchedTables[step.id];
  if (!tables) throw new Error("Session migration must explicitly declare touchedTables before startup");
  return { ...step, touchedTables: tables };
});
