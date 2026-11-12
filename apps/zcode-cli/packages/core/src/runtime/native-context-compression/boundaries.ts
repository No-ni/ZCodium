import { isDeepStrictEqual } from "node:util";
import { NativeContextStoreConflictError, selectActiveConversationBranch } from "@zcode/contracts";
import {
  createRecommendedNativeContextConfiguration,
  type NativeContextForkBundle,
  type NativeContextOperation,
} from "@zcode/shared/native-context-compression";
import { MessageHistoryImpl } from "../../agent/message-history.js";
import { hydrateMessageHistoryFromSession } from "../../agent/session-history-hydrator.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { NativeContextRuntimeError } from "./contract.js";
import { historyVersionOf, nativeHash } from "./identity.js";
import {
  ensureNativeState,
  initialNativeState,
  nativeOwner,
  operationSummary,
  publishNativeStatus,
  writeNativeState,
} from "./state.js";
import {
  filterNativeBoundaryState,
  nativeBoundaryMembers,
  nativeForkHistoryVersion,
  remapNativeBoundaryState,
  type NativeContextBoundaryMembers,
  type NativeContextForkIdentityMaps,
} from "./boundary-state.js";
import {
  filterNativeBoundaryRecords,
  nativeForkRecordId,
  remapNativeBoundaryRecords,
  settleInterruptedNativeRecords,
  type NativeContextBoundaryRecords,
} from "./boundary-records.js";
import {
  pruneNativeProjectionOperations,
  remapNativeProjectionOperationIds,
} from "./projection-operations.js";

export type { NativeContextForkIdentityMaps } from "./boundary-state.js";

function supportsNativeBoundary(runtime: AgentRuntimeInternal): boolean {
  const store = runtime.sessionStore;
  return Boolean(
    store?.getNativeContextState && store.commitNativeContext && store.getNativeContextForkBundle,
  );
}

async function readNativeBoundary(runtime: AgentRuntimeInternal, allowStaleGeneration: boolean) {
  const store = runtime.sessionStore!;
  const [session, messages, bundle] = await Promise.all([
    store.getSession(runtime.sessionId),
    store.messages({ sessionID: runtime.sessionId }),
    store.getNativeContextForkBundle!(
      runtime.sessionId,
      allowStaleGeneration ? { allowStaleGeneration: true } : undefined,
    ),
  ]);
  if (!session || session.time.deleted !== undefined)
    throw new NativeContextRuntimeError("unavailable", "session");
  if ((session.revert?.branchGeneration ?? 0) !== runtime.branchGeneration)
    throw new NativeContextRuntimeError("conflict", "generation");
  const branch = selectActiveConversationBranch(messages, {
    branchCutAfterMessageId: session.revert?.branchCutAfterMessageID,
    rewindCreatedMessageId: session.revert?.createdMessageID,
    rewindKeptMessageIds: session.revert?.keptMessageIDs,
    rewindTargetMessageId: session.revert?.targetMessageID,
  });
  return { bundle, branch, members: nativeBoundaryMembers(branch) };
}

function compactMarker(
  members: NativeContextBoundaryMembers,
  state: NativeContextForkBundle["state"],
  records: NativeContextBoundaryRecords,
): NativeContextOperation | null {
  const boundary = members.compact;
  if (!boundary) return null;
  const operationId = `nctx_compact_${nativeHash(boundary.boundaryId).slice(0, 40)}`;
  if (records.operations.some((operation) => operation.operationId === operationId)) return null;
  return {
    operationId,
    commandId: null,
    anchorMessageId: boundary.messageId,
    anchorRequestSeq:
      records.observations.findLast((observation) => observation.purpose === "main")?.requestSeq ??
      null,
    kind: "compact-boundary",
    trigger: boundary.automatic ? "automatic" : "manual",
    status: "completed",
    generation: state.generation,
    policyVersion: state.policy.policyVersion,
    historyVersion: state.historyVersion,
    segmentId: boundary.boundaryId,
    createdAt: boundary.createdAt,
    completedAt: boundary.createdAt,
    elapsedMs: null,
    beforeEstimate: null,
    afterEstimate: null,
    model: null,
    observationIds: [],
    blockIds: [],
    sources: [],
    summary: "",
    reason: null,
    origin: "own",
  };
}

/** 从磁盘重载前先取消候选；迟到模型结果仍由原冻结边界拒绝。 */
async function synchronizeNativeBoundary(
  runtime: AgentRuntimeInternal,
  restoring: boolean,
  expectedCompactBoundary?: string,
): Promise<void> {
  if (!supportsNativeBoundary(runtime)) return;
  const owner = nativeOwner(runtime);
  owner.cancellation?.abort();
  owner.cancellation = undefined;
  owner.maintenanceStartedAt = undefined;
  owner.phase = "idle";
  owner.pendingOperationIds = [];
  owner.inputBudget = null;
  owner.restoreImageRefs?.clear();
  owner.commandResults?.clear();
  if (restoring) owner.restoring = true;
  if (owner.initialization) {
    try {
      await owner.initialization;
    } catch (error) {
      // 已落盘 rewind 而 native 未重挂时，旧初始化的严格分页会报 generation 冲突。
      if (!(error instanceof NativeContextStoreConflictError) || error.reason !== "generation")
        throw error;
    }
  }
  await owner.serial;
  const generation = runtime.branchGeneration;
  const historyVersion = historyVersionOf(runtime.messageHistory.borrowReadOnlyRuntimeEntries());
  const snapshot = await readNativeBoundary(runtime, true);
  await owner.serial;
  if (
    generation !== runtime.branchGeneration ||
    historyVersion !== historyVersionOf(runtime.messageHistory.borrowReadOnlyRuntimeEntries())
  )
    throw new NativeContextRuntimeError("conflict", "history-changed");
  if (
    expectedCompactBoundary !== undefined &&
    snapshot.members.compact?.boundaryId !== expectedCompactBoundary
  )
    throw new NativeContextRuntimeError("invalid-state", "compact-boundary");
  owner.initialization = undefined;
  const persisted = snapshot.bundle;
  if (persisted && owner.state && owner.state.revision > persisted.state.revision)
    throw new NativeContextRuntimeError("conflict", "revision");
  owner.state = persisted?.state ?? null;
  if (!persisted) {
    // 老任务只建立 manual 与真实历史边界，不把过去的 compact/用量回填为新操作。
    await ensureNativeState(owner);
    const initial = owner.state!;
    const next = filterNativeBoundaryState(initial, snapshot.members, generation, historyVersion);
    if (!isDeepStrictEqual(initial, next)) {
      await writeNativeState(owner, (candidate) => {
        Object.assign(candidate, next);
      });
    } else {
      await publishNativeStatus(owner);
    }
    return;
  }
  const changed =
    persisted.state.generation !== generation ||
    persisted.state.compactBoundaryId !== (snapshot.members.compact?.boundaryId ?? "initial");
  const retained =
    persisted.state.generation !== generation
      ? filterNativeBoundaryRecords(persisted, snapshot.members)
      : { operations: persisted.operations, observations: persisted.observations };
  const records = settleInterruptedNativeRecords(retained, changed, Date.now());
  const next = filterNativeBoundaryState(
    persisted.state,
    snapshot.members,
    generation,
    historyVersion,
  );
  pruneNativeProjectionOperations(
    next,
    new Set(
      records.operations
        .filter((operation) => operation.status === "completed")
        .map((operation) => operation.operationId),
    ),
  );
  next.requestSeq = records.observations.reduce(
    (maximum, observation) => Math.max(maximum, observation.requestSeq),
    next.requestSeq,
  );
  if (persisted.state.compactBoundaryId !== next.compactBoundaryId) {
    const marker = compactMarker(snapshot.members, next, records);
    if (marker) records.operations.push(marker);
  }
  const generationChanged = persisted.state.generation !== generation;
  const oldOperations = new Map(
    persisted.operations.map((operation) => [operation.operationId, operation]),
  );
  const oldObservations = new Map(
    persisted.observations.map((observation) => [observation.id, observation]),
  );
  const operations = generationChanged
    ? records.operations
    : records.operations.filter(
        (operation) => !isDeepStrictEqual(oldOperations.get(operation.operationId), operation),
      );
  const observations = generationChanged
    ? records.observations
    : records.observations.filter(
        (observation) => !isDeepStrictEqual(oldObservations.get(observation.id), observation),
      );
  const updateHeads = () => {
    owner.lastObservation =
      records.observations.findLast((observation) => observation.purpose === "main") ?? null;
    const lastOperation = records.operations.at(-1);
    owner.lastOperation = lastOperation ? operationSummary(lastOperation) : null;
  };
  if (!isDeepStrictEqual(next, persisted.state) || operations.length || observations.length) {
    await writeNativeState(
      owner,
      (candidate) => {
        if (
          candidate.revision !== persisted.state.revision ||
          generation !== runtime.branchGeneration ||
          historyVersion !== historyVersionOf(runtime.messageHistory.borrowReadOnlyRuntimeEntries())
        )
          throw new NativeContextRuntimeError("conflict", "history-changed");
        Object.assign(candidate, next);
      },
      { operations, observations },
      updateHeads,
    );
  } else {
    updateHeads();
    await publishNativeStatus(owner);
  }
}

export async function recoverNativeContext(runtime: AgentRuntimeInternal): Promise<void> {
  await synchronizeNativeBoundary(runtime, true);
}
export async function rebaseNativeContext(runtime: AgentRuntimeInternal): Promise<void> {
  await synchronizeNativeBoundary(runtime, true);
}
export async function resetNativeContextAfterCompact(
  runtime: AgentRuntimeInternal,
  boundaryId: string,
): Promise<void> {
  await synchronizeNativeBoundary(runtime, false, boundaryId);
}

/** 只构造 bundle；真正写入与 child transcript 共用既有 fork 事务。 */
export async function buildNativeContextForkBundle(
  runtime: AgentRuntimeInternal,
  maps: NativeContextForkIdentityMaps,
  prefixMessageIds: readonly string[],
): Promise<NativeContextForkBundle | null> {
  if (!supportsNativeBoundary(runtime)) return null;
  await nativeOwner(runtime).serial;
  const snapshot = await readNativeBoundary(runtime, false);
  if (
    new Set(prefixMessageIds).size !== prefixMessageIds.length ||
    prefixMessageIds.some(
      (id, index) => snapshot.branch[index]?.info.id !== id || !maps.messageIds.has(id),
    )
  )
    throw new NativeContextRuntimeError("invalid-range", "fork-prefix");
  const prefix = snapshot.branch.slice(0, prefixMessageIds.length);
  const members = nativeBoundaryMembers(prefix);
  for (const partId of members.partOwners.keys())
    if (!maps.partIds.has(partId))
      throw new NativeContextRuntimeError("invalid-range", "fork-part");
  for (const callId of members.toolCallIds)
    if (!maps.toolCallIds.has(callId))
      throw new NativeContextRuntimeError("invalid-range", "fork-tool-call");
  const history = new MessageHistoryImpl();
  await hydrateMessageHistoryFromSession({
    history,
    messages: prefix,
    artifactStore: runtime.artifactStore,
  });
  const parentState =
    snapshot.bundle?.state ??
    initialNativeState(
      runtime,
      runtime.config.nativeContextCompression ??
        createRecommendedNativeContextConfiguration("manual"),
    );
  const state = remapNativeBoundaryState(
    filterNativeBoundaryState(
      parentState,
      members,
      runtime.branchGeneration,
      historyVersionOf(history.borrowReadOnlyRuntimeEntries()),
    ),
    maps,
  );
  state.historyVersion = nativeForkHistoryVersion(history.borrowReadOnlyRuntimeEntries(), maps);
  const retained = snapshot.bundle
    ? filterNativeBoundaryRecords(snapshot.bundle, members)
    : { operations: [], observations: [] };
  const records = remapNativeBoundaryRecords(
    settleInterruptedNativeRecords(retained, true, Date.now()),
    maps,
  );
  remapNativeProjectionOperationIds(
    state,
    new Map(
      retained.operations
        .filter((operation) => operation.status === "completed")
        .map((operation) => [
          operation.operationId,
          nativeForkRecordId(maps, "operation", operation.operationId),
        ]),
    ),
  );
  state.requestSeq = records.observations.reduce(
    (maximum, observation) => Math.max(maximum, observation.requestSeq),
    state.requestSeq,
  );
  state.imageReceipts = state.imageReceipts.map((receipt) => ({
    ...receipt,
    logicalRequestId: nativeForkRecordId(maps, "request", receipt.logicalRequestId),
  }));
  return { state, ...records };
}
