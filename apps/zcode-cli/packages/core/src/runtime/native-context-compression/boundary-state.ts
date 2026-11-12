import { createInitialState, highestUsedIndex, type CompressionState } from "acp-kernel";
import type { MessageWithParts } from "@zcode/contracts";
import type { NativeContextStoredState } from "@zcode/shared/native-context-compression";
import { cloneRuntimeMessageEntry, type RuntimeMessageEntry } from "../../agent/message-history.js";
import { NativeContextRuntimeError } from "./contract.js";
import { nativeMessageId } from "./guards.js";
import { historyVersionOf } from "./identity.js";
import { kernelOf } from "./state.js";
import {
  pruneNativeProjectionOperations,
  remapNativeProjectionRawIds,
} from "./projection-operations.js";

export interface NativeContextForkIdentityMaps {
  childSessionId: string;
  messageIds: ReadonlyMap<string, string>;
  partIds: ReadonlyMap<string, string>;
  toolCallIds: ReadonlyMap<string, string>;
}
export interface NativeContextBoundaryMembers {
  messageIds: ReadonlySet<string>;
  partOwners: ReadonlyMap<string, string>;
  filePartIds: ReadonlySet<string>;
  completedResponseIds: ReadonlySet<string>;
  toolCallIds: ReadonlySet<string>;
  compact: { boundaryId: string; messageId: string; createdAt: number; automatic: boolean } | null;
}

/** 来源归属使用完整分支；provider compact scope 只决定发送历史。 */
export function nativeBoundaryMembers(
  messages: readonly MessageWithParts[],
): NativeContextBoundaryMembers {
  const messageIds = new Set<string>();
  const partOwners = new Map<string, string>();
  const filePartIds = new Set<string>();
  const completedResponseIds = new Set<string>();
  const toolCallIds = new Set<string>();
  let compact: NativeContextBoundaryMembers["compact"] = null;
  for (const message of messages) {
    const id = String(message.info.id);
    messageIds.add(id);
    if (
      message.info.role === "assistant" &&
      !message.info.error &&
      message.info.time.completed !== undefined
    ) {
      completedResponseIds.add(id);
    }
    for (const part of message.parts) {
      partOwners.set(part.id, id);
      if (part.type === "file") filePartIds.add(part.id);
      if (part.type === "tool") {
        toolCallIds.add(part.callID);
        if (part.state.status === "completed")
          for (const attachment of part.state.attachments ?? []) {
            partOwners.set(attachment.id, id);
            filePartIds.add(attachment.id);
          }
      }
      if (part.type === "compaction" && (part.compactBoundary || !part.timelineStatus)) {
        compact = {
          boundaryId: part.compactBoundary?.boundaryId ?? `legacy-compact:${part.id}`,
          messageId: id,
          createdAt: message.info.time.created,
          automatic: part.compactBoundary ? part.compactBoundary.trigger !== "manual" : part.auto,
        };
      }
    }
  }
  return { messageIds, partOwners, filePartIds, completedResponseIds, toolCallIds, compact };
}

export function nativeBoundaryPartAllowed(
  members: NativeContextBoundaryMembers,
  messageId: string,
  partId: string | null,
): boolean {
  return (
    members.messageIds.has(messageId) &&
    (partId === null || members.partOwners.get(partId) === messageId)
  );
}
function rawAllowed(members: NativeContextBoundaryMembers, rawId: string): boolean {
  return /#e\d+(?::(?:c|image)\d+)?$/.test(rawId) && members.messageIds.has(nativeMessageId(rawId));
}
function filterCompressionSidecars(
  compression: CompressionState,
  members: NativeContextBoundaryMembers,
): void {
  const refs = new Set(Object.values(compression.messageRefs.byRaw));
  const rawIds = new Set(Object.keys(compression.messageRefs.byRaw));
  for (const name of ["hiddenOrphanRefs", "deadRefs", "renderDeferredRefs"] as const) {
    if (compression[name]) compression[name] = compression[name].filter((ref) => refs.has(ref));
  }
  if (compression.sweptOrphanCallIds)
    compression.sweptOrphanCallIds = compression.sweptOrphanCallIds.filter((id) =>
      members.toolCallIds.has(id),
    );
  if (compression.emergencyTruncateLatch)
    compression.emergencyTruncateLatch = compression.emergencyTruncateLatch.filter((entry) =>
      refs.has(entry.ref),
    );
  if (compression.viewLatches)
    compression.viewLatches = Object.fromEntries(
      Object.entries(compression.viewLatches).filter(([ref]) => refs.has(ref)),
    );
  if (compression.tsStamps)
    compression.tsStamps = Object.fromEntries(
      Object.entries(compression.tsStamps).filter(([raw]) => rawIds.has(raw)),
    );
  if (compression.lastPassIds)
    compression.lastPassIds = compression.lastPassIds.filter((raw) => rawIds.has(raw));
  if (compression.absorbed)
    compression.absorbed = compression.absorbed.filter(
      (entry) =>
        rawIds.has(entry.callMessageId) &&
        rawIds.has(entry.resultMessageId) &&
        members.toolCallIds.has(entry.toolCallId),
    );
}

/** 部分覆盖的块整块丢弃；不能把父摘要截成仍包含未来内容的“前缀摘要”。 */
export function filterNativeBoundaryState(
  state: NativeContextStoredState,
  members: NativeContextBoundaryMembers,
  generation: number,
  historyVersion: string,
): NativeContextStoredState {
  const next = structuredClone(state);
  const kernel = kernelOf(next);
  const original = kernel.compression;
  const boundaryId = members.compact?.boundaryId ?? "initial";
  const compactChanged = state.compactBoundaryId !== boundaryId;
  const generationChanged = state.generation !== generation;
  kernel.refHighWaterIndex = Math.max(
    kernel.refHighWaterIndex ?? 0,
    highestUsedIndex(original.messageRefs),
  );
  const byRaw = Object.fromEntries(
    Object.entries(original.messageRefs.byRaw).filter(([raw]) => rawAllowed(members, raw)),
  );
  const liveRefs = new Set(Object.values(byRaw));
  const tokenSnapshot = Object.fromEntries(
    Object.entries(original.tokenSnapshot).filter(([ref]) => liveRefs.has(ref)),
  );
  let blocks = original.blocks.filter(
    (block) =>
      block.effectiveMessageIds.length > 0 &&
      block.effectiveMessageIds.every((raw) => byRaw[raw] !== undefined) &&
      block.directMessageIds.every((raw) => byRaw[raw] !== undefined),
  );
  let previousSize = -1;
  while (previousSize !== blocks.length) {
    previousSize = blocks.length;
    const ids = new Set(blocks.map((block) => block.blockId));
    blocks = blocks.filter((block) => block.directBlockIds.every((id) => ids.has(id)));
  }
  const compression = compactChanged ? createInitialState() : original;
  const removedBlocks = blocks.length !== original.blocks.length;
  compression.messageRefs = {
    byRaw,
    byRef: Object.fromEntries(Object.entries(byRaw).map(([raw, ref]) => [ref, raw])),
  };
  compression.tokenSnapshot = tokenSnapshot;
  compression.nextBlockId = original.nextBlockId;
  compression.nextRunId = original.nextRunId;
  compression.blocks = compactChanged ? [] : blocks;
  if (original.tsStamps) compression.tsStamps = original.tsStamps;
  if (compactChanged || removedBlocks) {
    compression.stats = {
      tokensCompressed: compression.blocks.reduce((sum, block) => sum + block.compressedTokens, 0),
      compressionCount: compression.blocks.length,
    };
  }
  filterCompressionSidecars(compression, members);
  if (generationChanged || compactChanged) {
    compression.nudge = createInitialState().nudge;
    compression.terminalStreak = 0;
    delete compression.pendingOrphanSweepMinRef;
  }
  kernel.compression = compression;
  kernel.views = compactChanged
    ? {}
    : Object.fromEntries(Object.entries(kernel.views).filter(([raw]) => byRaw[raw] !== undefined));
  pruneNativeProjectionOperations(next);
  if (kernel.omittedReasoningIds)
    kernel.omittedReasoningIds = compactChanged
      ? []
      : kernel.omittedReasoningIds.filter((raw) => byRaw[raw] !== undefined);
  next.sources = next.sources.filter(
    (source) =>
      nativeBoundaryPartAllowed(members, source.messageId, source.partId) &&
      byRaw[source.rawId] === source.ref &&
      nativeMessageId(source.rawId) === source.messageId,
  );
  const keptImageRefs = new Set(
    next.sources.filter((source) => source.kind === "image").map((source) => source.ref),
  );
  if (kernel.imageViews)
    kernel.imageViews = compactChanged
      ? {}
      : Object.fromEntries(
          Object.entries(kernel.imageViews).filter(([ref]) => keptImageRefs.has(ref)),
        );
  if (kernel.omittedImageRefs)
    kernel.omittedImageRefs = compactChanged
      ? []
      : kernel.omittedImageRefs.filter((ref) => keptImageRefs.has(ref));
  const imageRefs = new Set(
    next.sources
      .filter(
        (source) =>
          source.kind === "image" &&
          source.originalAvailable &&
          source.artifactUri &&
          source.partId &&
          members.filePartIds.has(source.partId),
      )
      .map((source) => source.ref),
  );
  next.imageReceipts = compactChanged
    ? []
    : next.imageReceipts
        .filter(
          (receipt) =>
            imageRefs.has(receipt.ref) &&
            members.completedResponseIds.has(receipt.responseMessageId),
        )
        .map((receipt) => ({ ...receipt, generation }));
  next.generation = generation;
  next.historyVersion = historyVersion;
  next.compactBoundaryId = boundaryId;
  if (generationChanged || compactChanged || state.historyVersion !== historyVersion)
    next.lastCheckedHistoryVersion = null;
  if (generationChanged || compactChanged) {
    next.lastMaintenanceTokens = 0;
    next.roundsSinceMaintenance = 0;
    next.estimateHoldRounds = 0;
  }
  return next;
}

export function remapNativeRawId(rawId: string, maps: NativeContextForkIdentityMaps): string {
  const parent = nativeMessageId(rawId);
  const child = maps.messageIds.get(parent);
  if (!child || !rawId.startsWith(`${parent}#e`))
    throw new NativeContextRuntimeError("invalid-range", "fork-prefix");
  return `${child}${rawId.slice(parent.length)}`;
}

export function remapNativeBoundaryState(
  state: NativeContextStoredState,
  maps: NativeContextForkIdentityMaps,
): NativeContextStoredState {
  const next = structuredClone(state);
  const kernel = kernelOf(next);
  const compression = kernel.compression;
  const raw = (value: string) => remapNativeRawId(value, maps);
  const byRaw = Object.fromEntries(
    Object.entries(compression.messageRefs.byRaw).map(([id, ref]) => [raw(id), ref]),
  );
  compression.messageRefs = {
    byRaw,
    byRef: Object.fromEntries(Object.entries(byRaw).map(([id, ref]) => [ref, id])),
  };
  for (const block of compression.blocks) {
    block.directMessageIds = block.directMessageIds.map(raw);
    block.effectiveMessageIds = block.effectiveMessageIds.map(raw);
    if (block.compressCallId) {
      const id = maps.toolCallIds.get(block.compressCallId);
      if (id) block.compressCallId = id;
      else delete block.compressCallId;
    }
  }
  if (compression.tsStamps)
    compression.tsStamps = Object.fromEntries(
      Object.entries(compression.tsStamps).map(([id, stamp]) => [raw(id), stamp]),
    );
  if (compression.lastPassIds) compression.lastPassIds = compression.lastPassIds.map(raw);
  if (compression.sweptOrphanCallIds)
    compression.sweptOrphanCallIds = compression.sweptOrphanCallIds.flatMap((id) =>
      maps.toolCallIds.has(id) ? [maps.toolCallIds.get(id)!] : [],
    );
  if (compression.absorbed)
    compression.absorbed = compression.absorbed.flatMap((entry) => {
      const toolCallId = maps.toolCallIds.get(entry.toolCallId);
      return toolCallId
        ? [
            {
              ...entry,
              toolCallId,
              callMessageId: raw(entry.callMessageId),
              resultMessageId: raw(entry.resultMessageId),
              ...(entry.absorbCallId && maps.toolCallIds.has(entry.absorbCallId)
                ? { absorbCallId: maps.toolCallIds.get(entry.absorbCallId)! }
                : { absorbCallId: undefined }),
            },
          ]
        : [];
    });
  kernel.views = Object.fromEntries(
    Object.entries(kernel.views).map(([id, view]) => [raw(id), view]),
  );
  remapNativeProjectionRawIds(next, raw);
  if (kernel.omittedReasoningIds) kernel.omittedReasoningIds = kernel.omittedReasoningIds.map(raw);
  // 父任务的策略命令回执不能吞掉 child 的新命令；ref 副本缓存仍按原编号继承。
  delete kernel.policyCommands;
  next.sources = next.sources.map((source) => {
    const messageId = maps.messageIds.get(source.messageId);
    const partId = source.partId === null ? null : maps.partIds.get(source.partId);
    if (!messageId || partId === undefined)
      throw new NativeContextRuntimeError("invalid-range", "fork-part");
    return { ...source, messageId, partId, rawId: raw(source.rawId) };
  });
  next.imageReceipts = next.imageReceipts.map((receipt) => ({
    ...receipt,
    responseMessageId: maps.messageIds.get(receipt.responseMessageId)!,
    generation: 0,
  }));
  next.revision = 0;
  next.generation = 0;
  next.lastCheckedHistoryVersion = null;
  next.lastMaintenanceTokens = 0;
  next.roundsSinceMaintenance = 0;
  next.estimateHoldRounds = 0;
  compression.nudge = createInitialState().nudge;
  return next;
}

/** 只重映射已知 canonical 身份与协议 call id；正文保持原样。 */
export function nativeForkHistoryVersion(
  entries: readonly RuntimeMessageEntry[],
  maps: NativeContextForkIdentityMaps,
): string {
  const mapped = entries.map((original) => {
    const entry = cloneRuntimeMessageEntry(original);
    if (entry.canonical) {
      const canonical = entry.canonical;
      const messageId = maps.messageIds.get(canonical.messageId);
      if (!messageId) throw new NativeContextRuntimeError("invalid-range", "fork-prefix");
      entry.canonical = {
        ...canonical,
        messageId,
        ...(canonical.partId ? { partId: maps.partIds.get(canonical.partId) } : {}),
        ...(canonical.imagePartIds
          ? { imagePartIds: canonical.imagePartIds.map((id) => maps.partIds.get(id)!) }
          : {}),
      };
    }
    if (entry.kind !== "attachment") {
      if (entry.message.toolCalls)
        entry.message.toolCalls = entry.message.toolCalls.map((call) => ({
          ...call,
          id: maps.toolCallIds.get(call.id) ?? call.id,
        }));
      if (entry.message.toolCallId)
        entry.message.toolCallId =
          maps.toolCallIds.get(entry.message.toolCallId) ?? entry.message.toolCallId;
    }
    return entry;
  });
  return historyVersionOf(mapped);
}
