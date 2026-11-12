import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { NativeContextStoreConflictError } from "@zcode/contracts";
import {
  nativeContextCommitSchema,
  nativeContextForkBundleSchema,
  nativeContextOperationSchema,
  nativeContextOperationSummarySchema,
  nativeContextPageRequestSchema,
  type NativeContextCommit,
  type NativeContextForkBundle,
  type NativeContextObservation,
  type NativeContextOperation,
  type NativeContextStoredState,
} from "@zcode/shared/native-context-compression";
import type { NativeContextPageQuery, NativeContextSqliteRepository } from "./contract.js";
import { nativeImageAssociationsForCommit } from "./image-associations.js";
import {
  decodeObservation,
  decodeOperation,
  recordsMatch,
  writeObservation,
  writeOperation,
  type NativeContextRecordRow,
  type NativeContextRecordTable,
} from "./records.js";
import {
  assertReadable,
  inTransaction,
  pageMetadata,
  readHeader,
  readState,
  writeState,
} from "./state.js";

const pageQuerySchema = nativeContextPageRequestSchema.omit({ sessionId: true });

/** 在事务前完成 JSON 归一化；未知用量仍是 null，不通过旧 usage 的零填充编码。 */
function normalizeCommit(commit: NativeContextCommit): NativeContextCommit {
  return nativeContextCommitSchema.parse(
    JSON.parse(JSON.stringify(nativeContextCommitSchema.parse(commit))),
  );
}

function writeRecords(
  db: DatabaseSync,
  sessionId: string,
  state: NativeContextStoredState,
  operations: readonly NativeContextOperation[],
  observations: readonly NativeContextObservation[],
): void {
  const imageAssociations = nativeImageAssociationsForCommit(
    db,
    sessionId,
    state,
    operations,
    observations,
  );
  writeState(db, sessionId, state);
  for (const operation of operations) writeOperation(db, sessionId, state.generation, operation);
  for (const observation of observations)
    writeObservation(
      db,
      sessionId,
      state.generation,
      observation,
      imageAssociations.get(observation.id),
    );
}

function commit(db: DatabaseSync, sessionId: string, candidate: NativeContextCommit): void {
  const input = normalizeCommit(candidate);
  const nextRevision = input.expectedRevision === null ? 0 : input.expectedRevision + 1;
  if (input.state.revision !== nextRevision) {
    throw new NativeContextStoreConflictError("revision");
  }
  inTransaction(db, "write", () => {
    const header = readHeader(db, sessionId);
    if (!header) throw new NativeContextStoreConflictError("missing-session");
    if (
      header.branchGeneration !== input.expectedGeneration ||
      input.state.generation !== input.expectedGeneration
    ) {
      throw new NativeContextStoreConflictError("generation");
    }
    const operations = input.operations ?? [];
    const observations = input.observations ?? [];
    if (
      header.revision === input.state.revision &&
      isDeepStrictEqual(readState(db, sessionId), input.state) &&
      recordsMatch(db, sessionId, input.state.generation, operations, observations)
    ) {
      return;
    }
    if (header.revision !== input.expectedRevision) {
      throw new NativeContextStoreConflictError("revision");
    }
    writeRecords(db, sessionId, input.state, operations, observations);
  });
}

function listRows(
  db: DatabaseSync,
  table: NativeContextRecordTable,
  sessionId: string,
  request: NativeContextPageQuery,
) {
  const query = pageQuerySchema.parse(request);
  return inTransaction(db, "read", () => {
    const header = readHeader(db, sessionId);
    if (!header) throw new NativeContextStoreConflictError("missing-session");
    assertReadable(header, query.expectedRevision);
    if (header.generation === null) {
      return { header, rows: [] as NativeContextRecordRow[], nextCursor: null };
    }
    const conditions = ["session_id=?", "active_generation=?"];
    const parameters: (string | number)[] = [sessionId, header.generation];
    if (table === "native_context_observation" && query.purpose !== undefined) {
      conditions.push("purpose=?");
      parameters.push(query.purpose);
    }
    if (table === "native_context_observation" && query.operationId !== undefined) {
      conditions.push(
        "exists(select 1 from json_each(native_context_observation.data, '$.operationIds') as association " +
          "where association.value=?)",
      );
      parameters.push(query.operationId);
    }
    if (query.segmentId !== undefined) {
      conditions.push("segment_id=?");
      parameters.push(query.segmentId);
    }
    if (query.cursor !== undefined) {
      conditions.push("sequence<?");
      parameters.push(query.cursor);
    }
    const limit = query.limit ?? 50;
    parameters.push(limit + 1);
    const rows = db
      .prepare(
        "select sequence,active_generation,data from " +
          table +
          " where " +
          conditions.join(" and ") +
          " order by sequence desc limit ?",
      )
      .all(...parameters) as unknown as NativeContextRecordRow[];
    const hasMore = rows.length > limit;
    const visible = hasMore ? rows.slice(0, limit) : rows;
    return { header, rows: visible, nextCursor: hasMore ? visible.at(-1)!.sequence : null };
  });
}

function getOperation(db: DatabaseSync, sessionId: string, operationId: string) {
  const id = nativeContextOperationSchema.shape.operationId.parse(operationId);
  return inTransaction(db, "read", () => {
    const header = readHeader(db, sessionId);
    if (!header) return null;
    assertReadable(header);
    if (header.generation === null) return null;
    const row = db
      .prepare(
        "select sequence,active_generation,data from native_context_operation " +
          "where session_id=? and active_generation=? and operation_id=?",
      )
      .get(sessionId, header.generation, id) as NativeContextRecordRow | undefined;
    return row ? decodeOperation(row) : null;
  });
}

function getForkBundle(
  db: DatabaseSync,
  sessionId: string,
  options?: { allowStaleGeneration?: boolean },
): NativeContextForkBundle | null {
  return inTransaction(db, "read", () => {
    const header = readHeader(db, sessionId);
    if (!header) return null;
    if (options?.allowStaleGeneration !== true) assertReadable(header);
    if (header.generation === null) return null;
    const state = readState(db, sessionId);
    if (!state) return null;
    const operations = db
      .prepare(
        "select sequence,active_generation,data from native_context_operation " +
          "where session_id=? and active_generation=? order by sequence",
      )
      .all(sessionId, state.generation) as unknown as NativeContextRecordRow[];
    const observations = db
      .prepare(
        "select sequence,active_generation,data from native_context_observation " +
          "where session_id=? and active_generation=? order by sequence",
      )
      .all(sessionId, state.generation) as unknown as NativeContextRecordRow[];
    return {
      state,
      operations: operations.map(decodeOperation),
      observations: observations.map(decodeObservation),
    };
  });
}

function writeForkBundleInTransaction(
  db: DatabaseSync,
  sessionId: string,
  candidate: NativeContextForkBundle,
): void {
  const bundle = nativeContextForkBundleSchema.parse(
    JSON.parse(JSON.stringify(nativeContextForkBundleSchema.parse(candidate))),
  );
  const header = readHeader(db, sessionId);
  if (!header) throw new NativeContextStoreConflictError("missing-session");
  if (header.revision !== null || bundle.state.revision !== 0) {
    throw new NativeContextStoreConflictError("revision");
  }
  if (header.branchGeneration !== 0 || bundle.state.generation !== 0) {
    throw new NativeContextStoreConflictError("generation");
  }
  writeRecords(db, sessionId, bundle.state, bundle.operations, bundle.observations);
}

export function createSqliteNativeContextRepository(
  db: DatabaseSync,
): NativeContextSqliteRepository {
  return {
    getState: (sessionId) => readState(db, sessionId),
    commit: (sessionId, input) => commit(db, sessionId, input),
    listObservations: (sessionId, request) => {
      const { header, rows, nextCursor } = listRows(
        db,
        "native_context_observation",
        sessionId,
        request,
      );
      return pageMetadata(header, rows.map(decodeObservation), nextCursor);
    },
    listOperations: (sessionId, request) => {
      const { header, rows, nextCursor } = listRows(
        db,
        "native_context_operation",
        sessionId,
        request,
      );
      return pageMetadata(
        header,
        rows.map((row) => {
          const { sources, summary, ...operation } = decodeOperation(row);
          void sources;
          void summary;
          return nativeContextOperationSummarySchema.parse(operation);
        }),
        nextCursor,
      );
    },
    getOperation: (sessionId, operationId) => getOperation(db, sessionId, operationId),
    getForkBundle: (sessionId, options) => getForkBundle(db, sessionId, options),
    writeForkBundleInTransaction: (sessionId, bundle) =>
      writeForkBundleInTransaction(db, sessionId, bundle),
  };
}
