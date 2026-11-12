import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { NativeContextStoreConflictError } from "@zcode/contracts";
import {
  nativeContextObservationSchema,
  nativeContextOperationSchema,
  type NativeContextObservation,
  type NativeContextOperation,
} from "@zcode/shared/native-context-compression";
import type { NativeContextImageAssociation } from "./image-associations.js";

export type NativeContextRecordTable = "native_context_operation" | "native_context_observation";

export interface NativeContextRecordRow {
  sequence: number;
  active_generation: number;
  data: string;
}

export function decodeObservation(row: NativeContextRecordRow): NativeContextObservation {
  return nativeContextObservationSchema.parse(JSON.parse(row.data));
}

export function decodeOperation(row: NativeContextRecordRow): NativeContextOperation {
  return nativeContextOperationSchema.parse(JSON.parse(row.data));
}

function observationRequest(value: NativeContextObservation) {
  const {
    status,
    actualInputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreateTokens,
    visionTokens,
    completedAt,
    ...request
  } = value;
  void status;
  void actualInputTokens;
  void outputTokens;
  void cacheReadTokens;
  void cacheCreateTokens;
  void visionTokens;
  void completedAt;
  return request;
}

function assertObservationUpdate(
  old: NativeContextObservation,
  next: NativeContextObservation,
  imageAssociation?: NativeContextImageAssociation,
): void {
  // 图片记录在真实主观察completed后才提交；同CAS证明仅开放关联后缀，费用和图片事实继续冻结。
  if (
    imageAssociation &&
    isDeepStrictEqual(old, imageAssociation.previous) &&
    isDeepStrictEqual({ ...old, operationIds: imageAssociation.operationIds }, next)
  )
    return;
  // 根因：终态补写不能把另一请求的估算/模型混入已有点，也不能把已结算结果降回 prepared。
  if (
    !isDeepStrictEqual(observationRequest(old), observationRequest(next)) ||
    (old.status !== "prepared" && !isDeepStrictEqual(old, next))
  ) {
    throw new NativeContextStoreConflictError("record");
  }
}

function assertOperationUpdate(old: NativeContextOperation, next: NativeContextOperation): void {
  const identity = (value: NativeContextOperation) => ({
    operationId: value.operationId,
    commandId: value.commandId,
    kind: value.kind,
    trigger: value.trigger,
    generation: value.generation,
    createdAt: value.createdAt,
    origin: value.origin,
  });
  const executionBoundary = (value: NativeContextOperation) => ({
    policyVersion: value.policyVersion,
    historyVersion: value.historyVersion,
    anchorMessageId: value.anchorMessageId,
    anchorRequestSeq: value.anchorRequestSeq,
    segmentId: value.segmentId,
  });
  // 接收命令时的 preparing 尚未选定执行历史；只在出队进入 running 时冻结一次，后续终态不能改写边界。
  const starting = old.status === "preparing" && next.status === "running";
  if (
    !isDeepStrictEqual(identity(old), identity(next)) ||
    (!starting && !isDeepStrictEqual(executionBoundary(old), executionBoundary(next))) ||
    (old.status === "running" && next.status === "preparing") ||
    (old.status !== "preparing" && old.status !== "running" && !isDeepStrictEqual(old, next))
  ) {
    throw new NativeContextStoreConflictError("record");
  }
}

function nextSequence(
  db: DatabaseSync,
  table: NativeContextRecordTable,
  sessionId: string,
): number {
  return Number(
    db
      .prepare(`select coalesce(max(sequence),0)+1 as next from ${table} where session_id=?`)
      .get(sessionId)?.next,
  );
}

export function writeObservation(
  db: DatabaseSync,
  sessionId: string,
  generation: number,
  observation: NativeContextObservation,
  imageAssociation?: NativeContextImageAssociation,
): void {
  const existing = db
    .prepare(
      "select sequence,active_generation,data from native_context_observation where session_id=? and id=?",
    )
    .get(sessionId, observation.id) as NativeContextRecordRow | undefined;
  const attempt = db
    .prepare(
      "select id from native_context_observation where session_id=? and logical_request_id=? " +
        "and attempt_index=? and purpose=?",
    )
    .get(sessionId, observation.logicalRequestId, observation.attemptIndex, observation.purpose);
  if (attempt && attempt.id !== observation.id) {
    throw new NativeContextStoreConflictError("record");
  }
  if (existing) assertObservationUpdate(decodeObservation(existing), observation, imageAssociation);
  db.prepare(
    "insert into native_context_observation(session_id,id,logical_request_id,attempt_index,purpose," +
      "sequence,active_generation,segment_id,data) values(?,?,?,?,?,?,?,?,?) " +
      "on conflict(session_id,id) do update set active_generation=excluded.active_generation,data=excluded.data",
  ).run(
    sessionId,
    observation.id,
    observation.logicalRequestId,
    observation.attemptIndex,
    observation.purpose,
    existing?.sequence ?? nextSequence(db, "native_context_observation", sessionId),
    generation,
    observation.segmentId,
    JSON.stringify(observation),
  );
}

export function writeOperation(
  db: DatabaseSync,
  sessionId: string,
  generation: number,
  operation: NativeContextOperation,
): void {
  const existing = db
    .prepare(
      "select sequence,active_generation,data from native_context_operation where session_id=? and operation_id=?",
    )
    .get(sessionId, operation.operationId) as NativeContextRecordRow | undefined;
  if (existing) assertOperationUpdate(decodeOperation(existing), operation);
  db.prepare(
    "insert into native_context_operation(session_id,operation_id,sequence,active_generation,segment_id,data) " +
      "values(?,?,?,?,?,?) on conflict(session_id,operation_id) do update set " +
      "active_generation=excluded.active_generation,segment_id=excluded.segment_id,data=excluded.data",
  ).run(
    sessionId,
    operation.operationId,
    existing?.sequence ?? nextSequence(db, "native_context_operation", sessionId),
    generation,
    operation.segmentId,
    JSON.stringify(operation),
  );
}

export function recordsMatch(
  db: DatabaseSync,
  sessionId: string,
  generation: number,
  operations: readonly NativeContextOperation[],
  observations: readonly NativeContextObservation[],
): boolean {
  const operationsMatch = operations.every((operation) => {
    const row = db
      .prepare(
        "select sequence,active_generation,data from native_context_operation where session_id=? and operation_id=?",
      )
      .get(sessionId, operation.operationId) as NativeContextRecordRow | undefined;
    return (
      row?.active_generation === generation && isDeepStrictEqual(decodeOperation(row), operation)
    );
  });
  return (
    operationsMatch &&
    observations.every((observation) => {
      const row = db
        .prepare(
          "select sequence,active_generation,data from native_context_observation where session_id=? and id=?",
        )
        .get(sessionId, observation.id) as NativeContextRecordRow | undefined;
      return (
        row?.active_generation === generation &&
        isDeepStrictEqual(decodeObservation(row), observation)
      );
    })
  );
}
