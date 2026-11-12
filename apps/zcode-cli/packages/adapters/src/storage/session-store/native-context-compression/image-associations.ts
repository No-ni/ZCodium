import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { NativeContextStoreConflictError } from "@zcode/contracts";
import {
  nativeContextObservationSchema,
  type NativeContextImageReceipt,
  type NativeContextObservation,
  type NativeContextOperation,
  type NativeContextSource,
  type NativeContextStoredState,
} from "@zcode/shared/native-context-compression";
import { readState } from "./state.js";

export interface NativeContextImageAssociation {
  previous: NativeContextObservation;
  operationIds: readonly string[];
}

function conflict(): never {
  throw new NativeContextStoreConflictError("record");
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function existingObservation(db: DatabaseSync, sessionId: string, id: string) {
  const row = db
    .prepare(
      "select active_generation,data from native_context_observation where session_id=? and id=?",
    )
    .get(sessionId, id) as { active_generation: number; data: string } | undefined;
  return row
    ? {
        generation: row.active_generation,
        observation: nativeContextObservationSchema.parse(JSON.parse(row.data)),
      }
    : null;
}

function operationExists(db: DatabaseSync, sessionId: string, id: string): boolean {
  return Boolean(
    db
      .prepare("select 1 from native_context_operation where session_id=? and operation_id=?")
      .get(sessionId, id),
  );
}

function sourceIndex(sources: readonly NativeContextSource[]) {
  const index = new Map<string, NativeContextSource | null>();
  for (const source of sources) index.set(source.ref, index.has(source.ref) ? null : source);
  return index;
}

function receiptIndex(receipts: readonly NativeContextImageReceipt[]) {
  const index = new Map<string, NativeContextImageReceipt[]>();
  for (const receipt of receipts) {
    const group = index.get(receipt.ref) ?? [];
    group.push(receipt);
    index.set(receipt.ref, group);
  }
  return index;
}

function imageView(state: NativeContextStoredState, ref: string) {
  const views = state.kernel.imageViews;
  if (!object(views) || !Object.hasOwn(views, ref)) return undefined;
  const view = views[ref];
  return object(view) &&
    typeof view.artifactUri === "string" &&
    view.artifactUri.length > 0 &&
    typeof view.mediaType === "string" &&
    view.mediaType.startsWith("image/") &&
    typeof view.bytes === "number" &&
    Number.isSafeInteger(view.bytes) &&
    view.bytes > 0
    ? view
    : undefined;
}

function boundaryMatches(state: NativeContextStoredState, observation: NativeContextObservation) {
  return (
    state.generation === observation.generation &&
    state.historyVersion === observation.historyVersion &&
    state.policy.policyVersion === observation.policyVersion &&
    state.compactBoundaryId === observation.segmentId
  );
}

function operationMatches(
  operation: NativeContextOperation,
  observation: NativeContextObservation,
) {
  return (
    operation.kind === "image" &&
    operation.status === "completed" &&
    operation.origin === "own" &&
    operation.generation === observation.generation &&
    operation.historyVersion === observation.historyVersion &&
    operation.policyVersion === observation.policyVersion &&
    operation.segmentId === observation.segmentId &&
    operation.anchorMessageId === observation.anchorMessageId &&
    operation.anchorRequestSeq === observation.requestSeq &&
    isDeepStrictEqual(operation.model, observation.model) &&
    isDeepStrictEqual(operation.observationIds, [observation.id]) &&
    operation.beforeEstimate === observation.beforeEstimate &&
    operation.afterEstimate === observation.afterEstimate &&
    operation.completedAt !== null &&
    operation.sources.length > 0
  );
}

function associationStateProof(
  db: DatabaseSync,
  sessionId: string,
  next: NativeContextStoredState,
) {
  const previous = readState(db, sessionId);
  if (!previous) conflict();
  return {
    previous,
    oldSources: sourceIndex(previous.sources),
    newSources: sourceIndex(next.sources),
    oldReceipts: receiptIndex(previous.imageReceipts),
    newReceipts: receiptIndex(next.imageReceipts),
  };
}

/** 同一个写事务的旧 snapshot 和整组候选证明；不能仅放松 operationIds 的终态冻结。 */
export function nativeImageAssociationsForCommit(
  db: DatabaseSync,
  sessionId: string,
  nextState: NativeContextStoredState,
  operations: readonly NativeContextOperation[],
  observations: readonly NativeContextObservation[],
): ReadonlyMap<string, NativeContextImageAssociation> {
  const permits = new Map<string, NativeContextImageAssociation>();
  // 普通用量/维护写入没有图片关联补写，不额外反序列化或索引整份大历史来源。
  let proof: ReturnType<typeof associationStateProof> | undefined;
  const operationById = new Map(operations.map((operation) => [operation.operationId, operation]));
  for (const next of observations) {
    const existing = existingObservation(db, sessionId, next.id);
    if (!existing || isDeepStrictEqual(existing.observation.operationIds, next.operationIds))
      continue;
    proof ??= associationStateProof(db, sessionId, nextState);
    const { previous, oldSources, newSources, oldReceipts, newReceipts } = proof;
    const old = existing.observation;
    if (
      !previous ||
      old.status !== "completed" ||
      old.purpose !== "main" ||
      old.origin !== "own" ||
      !old.anchorMessageId ||
      old.completedAt === null ||
      existing.generation !== nextState.generation ||
      !boundaryMatches(previous, old) ||
      !boundaryMatches(nextState, old) ||
      !isDeepStrictEqual(previous.policy, nextState.policy) ||
      !isDeepStrictEqual({ ...old, operationIds: next.operationIds }, next) ||
      next.operationIds.length <= old.operationIds.length ||
      new Set(next.operationIds).size !== next.operationIds.length ||
      !isDeepStrictEqual(next.operationIds.slice(0, old.operationIds.length), old.operationIds) ||
      observations.filter((item) => item.id === next.id).length !== 1 ||
      permits.has(next.id)
    )
      conflict();
    const refs = new Set<string>();
    let sent = 0,
      omitted = 0;
    for (const id of next.operationIds.slice(old.operationIds.length)) {
      const operation = operationById.get(id);
      if (
        !operation ||
        operations.filter((item) => item.operationId === id).length !== 1 ||
        operationExists(db, sessionId, id) ||
        !operationMatches(operation, old)
      )
        conflict();
      for (const recorded of operation.sources) {
        const source = newSources.get(recorded.ref),
          original = oldSources.get(recorded.ref);
        if (
          !source ||
          !original ||
          source.kind !== "image" ||
          !source.partId ||
          source.imageIndex === null ||
          !isDeepStrictEqual(source, original) ||
          refs.has(source.ref) ||
          !isDeepStrictEqual(recorded, {
            ref: source.ref,
            messageId: source.messageId,
            partId: source.partId,
            imageIndex: source.imageIndex,
            kind: "image",
            originalAvailable: source.originalAvailable,
          })
        )
          conflict();
        refs.add(source.ref);
        const view = imageView(nextState, source.ref);
        if (!view) conflict();
        const modelKey = old.model.providerId + "/" + old.model.modelId;
        const represented = (receipt: NativeContextImageReceipt) =>
          receipt.generation === old.generation &&
          receipt.modelKey === modelKey &&
          receipt.policyHash === view.policyHash &&
          receipt.representationHash === view.representationHash;
        const receipts = newReceipts.get(source.ref) ?? [];
        const received = receipts.some(
          (receipt) =>
            represented(receipt) &&
            receipt.responseMessageId === old.anchorMessageId &&
            receipt.logicalRequestId === old.logicalRequestId,
        );
        if (received) {
          sent++;
          continue;
        }
        const priorReceipt = (oldReceipts.get(source.ref) ?? []).find(
          (receipt) =>
            represented(receipt) && receipts.some((item) => isDeepStrictEqual(item, receipt)),
        );
        if (
          !priorReceipt ||
          !isDeepStrictEqual(imageView(previous, source.ref), view) ||
          !Array.isArray(nextState.kernel.omittedImageRefs) ||
          !nextState.kernel.omittedImageRefs.includes(source.ref)
        )
          conflict();
        omitted++;
      }
    }
    if (sent > old.images.sentCount || omitted > old.images.omittedCount) conflict();
    permits.set(next.id, { previous: old, operationIds: next.operationIds });
  }
  // 原因：只准许一方向补写会留下completed图片记录，却查不到其真实主观察。
  for (const operation of operations) {
    if (operation.kind !== "image" || operationExists(db, sessionId, operation.operationId))
      continue;
    for (const id of operation.observationIds) {
      if (
        existingObservation(db, sessionId, id) &&
        !permits.get(id)?.operationIds.includes(operation.operationId)
      )
        conflict();
    }
  }
  return permits;
}
