import type { DatabaseSync } from "node:sqlite";
import { NativeContextStoreConflictError } from "@zcode/contracts";
import {
  nativeContextStoredStateSchema,
  type NativeContextPage,
  type NativeContextStoredState,
} from "@zcode/shared/native-context-compression";

export interface NativeContextHeader {
  revision: number | null;
  generation: number | null;
  historyVersion: string | null;
  branchGeneration: number;
}

interface HeaderRow {
  revision: number | null;
  generation: number | null;
  history_version: string | null;
  revert: string | null;
}

/** 页查询只读取版本列，不为了 UI 数字页反序列化整份内核状态。 */
export function readHeader(db: DatabaseSync, sessionId: string): NativeContextHeader | null {
  const row = db
    .prepare(
      "select n.revision, n.generation, n.history_version, s.revert from session s " +
        "left join native_context_state n on n.session_id=s.id where s.id=?",
    )
    .get(sessionId) as HeaderRow | undefined;
  if (!row) return null;
  let branchGeneration = 0;
  if (row.revert !== null) {
    const revert: unknown = JSON.parse(row.revert);
    const value =
      revert && typeof revert === "object" && !Array.isArray(revert)
        ? (revert as Record<string, unknown>).branchGeneration
        : undefined;
    if (value !== undefined) {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new NativeContextStoreConflictError("generation");
      }
      branchGeneration = value;
    }
  }
  return {
    revision: row.revision,
    generation: row.generation,
    historyVersion: row.history_version,
    branchGeneration,
  };
}

export function readState(db: DatabaseSync, sessionId: string): NativeContextStoredState | null {
  const row = db
    .prepare("select data from native_context_state where session_id=?")
    .get(sessionId) as { data: string } | undefined;
  return row ? nativeContextStoredStateSchema.parse(JSON.parse(row.data)) : null;
}

export function assertReadable(header: NativeContextHeader, expectedRevision?: number): void {
  if (header.generation !== null && header.generation !== header.branchGeneration) {
    throw new NativeContextStoreConflictError("generation");
  }
  if (expectedRevision !== undefined && expectedRevision !== (header.revision ?? 0)) {
    throw new NativeContextStoreConflictError("revision");
  }
}

export function pageMetadata<T>(
  header: NativeContextHeader,
  items: T[],
  nextCursor: number | null,
): NativeContextPage<T> {
  return {
    items,
    nextCursor,
    revision: header.revision ?? 0,
    generation: header.branchGeneration,
    historyVersion: header.historyVersion ?? "uninitialized",
  };
}

export function writeState(
  db: DatabaseSync,
  sessionId: string,
  state: NativeContextStoredState,
): void {
  db.prepare(
    "insert into native_context_state(session_id,revision,generation,history_version,data) " +
      "values(?,?,?,?,?) on conflict(session_id) do update set revision=excluded.revision," +
      "generation=excluded.generation,history_version=excluded.history_version,data=excluded.data",
  ).run(sessionId, state.revision, state.generation, state.historyVersion, JSON.stringify(state));
}

/** 同步事务不 await；记录集合和页面版本共享同一个 SQLite snapshot。 */
export function inTransaction<T>(db: DatabaseSync, mode: "read" | "write", action: () => T): T {
  db.exec(mode === "write" ? "begin immediate" : "begin");
  try {
    const result = action();
    db.exec("commit");
    return result;
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}
