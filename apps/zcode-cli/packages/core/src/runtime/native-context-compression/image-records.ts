import type {
  NativeContextImageReceipt,
  NativeContextObservation,
  NativeContextOperation,
} from "@zcode/shared/native-context-compression";
import type { NativeContextRequestComparison } from "./contract.js";
import { nativeHash } from "./identity.js";
import { finishNativeOperation, nativeOperation } from "./records.js";
import type { NativeContextStateOwner } from "./state.js";

/** 成功发送记录与回执共用CAS；来源message和回复用量锚点各自保留真实身份。 */
export function nativeImageCommitFacts(
  owner: NativeContextStateOwner,
  input: {
    assistantMessageId: string;
    model: { providerId: string; modelId: string };
    comparison: NativeContextRequestComparison;
    receipts: readonly NativeContextImageReceipt[];
    omittedRefs: ReadonlySet<string>;
  },
): { operations: NativeContextOperation[]; observations: NativeContextObservation[] } {
  const state = owner.state!;
  const refs = new Set([...input.receipts.map((receipt) => receipt.ref), ...input.omittedRefs]);
  const sources = state.sources.filter((source) => source.kind === "image" && refs.has(source.ref));
  const observed = owner.lastObservation;
  const matching =
    observed?.purpose === "main" &&
    observed.status === "completed" &&
    observed.anchorMessageId === input.assistantMessageId &&
    observed.generation === input.comparison.generation &&
    observed.historyVersion === input.comparison.historyVersion &&
    observed.policyVersion === input.comparison.policyVersion &&
    observed.segmentId === input.comparison.segmentId &&
    observed.model.providerId === input.model.providerId &&
    observed.model.modelId === input.model.modelId &&
    input.receipts.every((receipt) => receipt.logicalRequestId === observed.logicalRequestId);
  const operation = finishNativeOperation(
    {
      ...nativeOperation(state, {
        kind: "image",
        trigger: input.comparison.policy.mode === "auto" ? "automatic" : "manual",
        model: input.model,
        anchorMessageId: input.assistantMessageId,
        sources,
      }),
      operationId:
        "native_img_" +
        nativeHash(
          JSON.stringify([
            input.assistantMessageId,
            input.model,
            input.comparison.generation,
            input.comparison.policyVersion,
          ]),
        ).slice(0, 40),
      anchorRequestSeq: matching ? observed.requestSeq : null,
      beforeEstimate: matching ? observed.beforeEstimate : null,
      afterEstimate: matching ? observed.afterEstimate : null,
    },
    "completed",
  );
  // 原因：主观察已在模型出口冻结；只能补关联，不能重算费用、图片计量或链接另一轮观察。
  const observations: NativeContextObservation[] =
    matching && observed.operationIds.length < 100
      ? [
          {
            ...observed,
            operationIds: [...new Set([...observed.operationIds, operation.operationId])],
          },
        ]
      : [];
  operation.observationIds = observations.map((observation) => observation.id);
  return { operations: [operation], observations };
}
