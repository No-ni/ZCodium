import { traceContextToLogContext, type TraceContext } from "@zcode/contracts";
import type {
  NativeContextObservation,
  NativeContextOperation,
} from "@zcode/shared/native-context-compression";
import { writeNativeState, type NativeContextStateOwner } from "./state.js";
import type { FrozenNativeAttempt } from "./attempt-facts.js";

export interface NativeAttemptRecord {
  observation: NativeContextObservation;
  persisted: boolean;
  persistedStatus?: NativeContextObservation["status"];
  terminal?: import("@zcode/contracts").ModelNetworkStatusEvent;
}
const sequences = new WeakMap<NativeContextStateOwner, number>();

export function nativeAttemptBoundary(
  owner: NativeContextStateOwner,
  frozen: FrozenNativeAttempt,
): boolean {
  return Boolean(
    owner.state &&
    owner.runtime.branchGeneration === frozen.generation &&
    owner.state.generation === frozen.generation &&
    owner.state.compactBoundaryId === frozen.segmentId,
  );
}

export function reserveNativeRequestSeq(
  owner: NativeContextStateOwner,
  purpose: NativeContextObservation["purpose"],
): number {
  const committed = owner.state!.requestSeq;
  if (purpose !== "main") return committed;
  // 仅在途编号预留，不对外暴露；写入失败也不在同进程复用已启动请求的编号。
  const next = Math.max(committed, sequences.get(owner) ?? 0) + 1;
  sequences.set(owner, next);
  return next;
}

export async function persistNativeAttempt(
  owner: NativeContextStateOwner,
  frozen: FrozenNativeAttempt,
  record: NativeAttemptRecord,
  traceContext: TraceContext,
  operationId?: string,
): Promise<void> {
  if (!nativeAttemptBoundary(owner, frozen)) return;
  try {
    const current = operationId
      ? await owner.runtime.sessionStore?.getNativeContextOperation?.(
          owner.runtime.sessionId,
          operationId,
        )
      : null;
    const operations: NativeContextOperation[] =
      current &&
      (current.status === "preparing" || current.status === "running") &&
      !current.observationIds.includes(record.observation.id)
        ? [
            {
              ...current,
              observationIds: [...current.observationIds, record.observation.id].slice(-100),
            },
          ]
        : [];
    let previous: NativeContextObservation | null = null;
    await writeNativeState(
      owner,
      (candidate) => {
        previous = owner.lastObservation;
        if (!nativeAttemptBoundary(owner, frozen))
          throw new Error("NATIVE_ATTEMPT_BOUNDARY_CHANGED");
        if (record.observation.purpose === "main") {
          candidate.requestSeq = Math.max(candidate.requestSeq, record.observation.requestSeq);
        }
      },
      { observations: [record.observation], operations },
      () => {
        record.persisted = true;
        record.persistedStatus = record.observation.status;
        if (record.observation.purpose === "main") {
          if (previous && previous.requestSeq > record.observation.requestSeq)
            owner.lastObservation = previous;
          else owner.inputBudget = record.observation.inputBudget;
          owner.pendingOperationIds = owner.pendingOperationIds.filter(
            (id) => !frozen.operationIds.includes(id),
          );
        }
      },
    );
  } catch {
    owner.runtime.logger?.warn("Native context observation write failed", {
      ...traceContextToLogContext(traceContext),
      event: "native.context.observation.write.failed",
      module: "core.runtime",
      status: "failed",
    });
  }
}
