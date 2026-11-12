export const NATIVE_CONTEXT_GOAL_USAGE_RECEIPT_MIGRATION = {
  id: "0025_native_context_goal_usage_receipt",
  appVersion: "3.17.1",
  touchedTables: ["session_target_usage_receipt"],
  sql: `
    create table if not exists session_target_usage_receipt (
      session_id text not null references session(id) on delete cascade,
      target_id text not null,
      usage_id text not null,
      tokens_used_delta integer not null check(tokens_used_delta >= 0),
      time_used_seconds_delta integer not null check(time_used_seconds_delta >= 0),
      time_accounted integer not null,
      primary key(session_id, target_id, usage_id)
    );
  `,
} as const;
