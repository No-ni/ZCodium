import type { ModelSelection } from "@zcode/contracts";
import type {
  NativeContextOperation,
  NativeContextStoredState,
  NativeContextSource,
} from "@zcode/shared/native-context-compression";
import { nativeHash } from "./identity.js";
export function nativeRecordSources(
  sources: readonly NativeContextSource[],
): NativeContextOperation["sources"] {
  return sources
    .filter((source) => source.kind !== "tool-call")
    .map(({ ref, messageId, partId, imageIndex, kind, originalAvailable }) => ({
      ref,
      messageId,
      partId,
      imageIndex,
      kind: kind as "text" | "tool-result" | "image",
      originalAvailable,
    }));
}
export function nativeOperation(
  state: NativeContextStoredState,
  input: {
    kind: NativeContextOperation["kind"];
    trigger: NativeContextOperation["trigger"];
    commandId?: string;
    model?: ModelSelection;
    anchorMessageId?: string;
    sources?: NativeContextSource[];
  },
): NativeContextOperation {
  const createdAt = Date.now();
  return {
    operationId: input.commandId
      ? `native_cmd_${nativeHash(input.commandId).slice(0, 32)}`
      : `native_op_${crypto.randomUUID()}`,
    commandId: input.commandId ?? null,
    anchorRequestSeq: state.requestSeq,
    anchorMessageId: input.anchorMessageId ?? null,
    kind: input.kind,
    trigger: input.trigger,
    status: "running",
    generation: state.generation,
    policyVersion: state.policy.policyVersion,
    historyVersion: state.historyVersion,
    segmentId: state.compactBoundaryId,
    createdAt,
    completedAt: null,
    elapsedMs: null,
    beforeEstimate: null,
    afterEstimate: null,
    model: input.model
      ? { providerId: input.model.providerId, modelId: input.model.modelId }
      : null,
    observationIds: [],
    blockIds: [],
    sources: nativeRecordSources(input.sources ?? []),
    summary: "",
    reason: null,
    origin: "own",
  };
}
export function finishNativeOperation(
  operation: NativeContextOperation,
  status: NativeContextOperation["status"],
  reason: NativeContextOperation["reason"] = null,
): NativeContextOperation {
  const completedAt = Date.now();
  return {
    ...operation,
    status,
    reason,
    completedAt,
    elapsedMs: Math.max(0, completedAt - operation.createdAt),
  };
}
