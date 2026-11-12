import type {
  NativeContextForkBundle,
  NativeContextObservation,
  NativeContextOperation,
} from "@zcode/shared/native-context-compression";
import { nativeHash } from "./identity.js";
import {
  nativeBoundaryPartAllowed,
  type NativeContextBoundaryMembers,
  type NativeContextForkIdentityMaps,
} from "./boundary-state.js";

export interface NativeContextBoundaryRecords {
  operations: NativeContextOperation[];
  observations: NativeContextObservation[];
}

/** 请求位置和正文 hash 不是可用于裁分支的消息身份。 */
export function filterNativeBoundaryRecords(
  bundle: NativeContextForkBundle,
  members: NativeContextBoundaryMembers,
): NativeContextBoundaryRecords {
  let operations = bundle.operations.filter(
    (operation) =>
      (operation.anchorMessageId
        ? members.messageIds.has(operation.anchorMessageId)
        : operation.sources.length > 0) &&
      operation.sources.every((source) =>
        nativeBoundaryPartAllowed(members, source.messageId, source.partId),
      ),
  );
  const anchoredOperationIds = new Set(operations.map((operation) => operation.operationId));
  let observations = bundle.observations.filter((observation) =>
    observation.anchorMessageId
      ? members.messageIds.has(observation.anchorMessageId)
      : observation.purpose !== "main" &&
        observation.operationIds.length > 0 &&
        observation.operationIds.every((id) => anchoredOperationIds.has(id)),
  );
  let previousSize = -1;
  // 维护与用量互相引用；缺失的一侧不能在 child 中伪装为完整的维护事实。
  while (previousSize !== operations.length + observations.length) {
    previousSize = operations.length + observations.length;
    const operationIds = new Set(operations.map((operation) => operation.operationId));
    observations = observations.filter((observation) =>
      observation.operationIds.every((id) => operationIds.has(id)),
    );
    const observationIds = new Set(observations.map((observation) => observation.id));
    operations = operations.filter((operation) =>
      operation.observationIds.every((id) => observationIds.has(id)),
    );
  }
  return { operations, observations };
}

export function settleInterruptedNativeRecords(
  records: NativeContextBoundaryRecords,
  changed: boolean,
  now: number,
): NativeContextBoundaryRecords {
  return {
    operations: records.operations.map((operation) =>
      operation.status === "preparing" || operation.status === "running"
        ? {
            ...operation,
            status: "obsolete",
            reason: changed ? "history-changed" : "cancelled",
            completedAt: now,
            elapsedMs: Math.max(0, now - operation.createdAt),
          }
        : operation,
    ),
    observations: records.observations.map((observation) =>
      observation.status === "prepared"
        ? { ...observation, status: "obsolete", completedAt: now }
        : observation,
    ),
  };
}

/** 从真实祖先 ID 派生 child 命名空间，不以正文猜测记录身份。 */
export function nativeForkRecordId(
  maps: NativeContextForkIdentityMaps,
  kind: "operation" | "observation" | "request",
  id: string,
): string {
  return `nctx_inherited_${nativeHash(JSON.stringify([maps.childSessionId, kind, id])).slice(0, 40)}`;
}
export function remapNativeBoundaryRecords(
  records: NativeContextBoundaryRecords,
  maps: NativeContextForkIdentityMaps,
): NativeContextBoundaryRecords {
  return {
    operations: records.operations.map((operation) => ({
      ...structuredClone(operation),
      origin: "inherited",
      operationId: nativeForkRecordId(maps, "operation", operation.operationId),
      ...(operation.anchorMessageId
        ? { anchorMessageId: maps.messageIds.get(operation.anchorMessageId)! }
        : {}),
      observationIds: operation.observationIds.map((id) =>
        nativeForkRecordId(maps, "observation", id),
      ),
      sources: operation.sources.map((source) => ({
        ...source,
        messageId: maps.messageIds.get(source.messageId)!,
        partId: source.partId === null ? null : maps.partIds.get(source.partId)!,
      })),
    })),
    observations: records.observations.map((observation) => ({
      ...structuredClone(observation),
      origin: "inherited",
      id: nativeForkRecordId(maps, "observation", observation.id),
      logicalRequestId: nativeForkRecordId(maps, "request", observation.logicalRequestId),
      ...(observation.anchorMessageId
        ? { anchorMessageId: maps.messageIds.get(observation.anchorMessageId)! }
        : {}),
      operationIds: observation.operationIds.map((id) => nativeForkRecordId(maps, "operation", id)),
    })),
  };
}
