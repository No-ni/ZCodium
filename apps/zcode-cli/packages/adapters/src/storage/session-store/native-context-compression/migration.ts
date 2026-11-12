export const NATIVE_CONTEXT_COMPRESSION_TABLES = [
  "native_context_state",
  "native_context_operation",
  "native_context_observation",
] as const;

export const NATIVE_CONTEXT_COMPRESSION_MIGRATION = {
  id: "0024_native_context_compression",
  appVersion: "3.17.1",
  touchedTables: NATIVE_CONTEXT_COMPRESSION_TABLES,
  sql: `
    create table if not exists native_context_state (
      session_id text primary key references session(id) on delete cascade,
      revision integer not null check(revision >= 0),
      generation integer not null check(generation >= 0),
      history_version text not null,
      data text not null
    );
    create table if not exists native_context_operation (
      session_id text not null references session(id) on delete cascade,
      operation_id text not null,
      sequence integer not null check(sequence > 0),
      active_generation integer not null check(active_generation >= 0),
      segment_id text not null,
      data text not null,
      primary key(session_id, operation_id),
      unique(session_id, sequence)
    );
    create index if not exists native_context_operation_page_idx
      on native_context_operation(session_id, active_generation, sequence desc);
    create index if not exists native_context_operation_segment_idx
      on native_context_operation(session_id, active_generation, segment_id, sequence desc);
    create table if not exists native_context_observation (
      session_id text not null references session(id) on delete cascade,
      id text not null,
      logical_request_id text not null,
      attempt_index integer not null check(attempt_index >= 0),
      purpose text not null,
      sequence integer not null check(sequence > 0),
      active_generation integer not null check(active_generation >= 0),
      segment_id text not null,
      data text not null,
      primary key(session_id, id),
      unique(session_id, logical_request_id, attempt_index, purpose),
      unique(session_id, sequence)
    );
    create index if not exists native_context_observation_page_idx
      on native_context_observation(session_id, active_generation, sequence desc);
    create index if not exists native_context_observation_segment_idx
      on native_context_observation(session_id, active_generation, segment_id, sequence desc);
    create index if not exists native_context_observation_purpose_idx
      on native_context_observation(session_id, active_generation, purpose, sequence desc);
    create index if not exists native_context_observation_purpose_segment_idx
      on native_context_observation(session_id, active_generation, purpose, segment_id, sequence desc);
  `,
} as const;
