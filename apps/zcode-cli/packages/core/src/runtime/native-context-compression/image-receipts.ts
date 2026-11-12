import type { MessageId } from "@zcode/contracts";
import { nativeContextImageReceiptSchema } from "@zcode/shared/native-context-compression";
import type {
  NativeContextImageReceipt,
  NativeContextSource,
  NativeContextStoredState,
} from "@zcode/shared/native-context-compression";
import type { AgentRuntimeInternal } from "../internal.js";
import type { NativeContextRequestComparison } from "./contract.js";
import { NativeContextRuntimeError } from "./contract.js";
import { historyVersionOf, nativeHash, nativeRawId } from "./identity.js";
import { nativeImageSourceIdentity } from "./image-identity.js";
import type { NativeImageView } from "./image-contract.js";
import { kernelOf, nativeOwner, writeNativeState } from "./state.js";
import { nativeImageCommitFacts } from "./image-records.js";

interface FrozenImageReceipt {
  receipt: NativeContextImageReceipt;
  identity: Omit<NativeContextImageReceipt, "logicalRequestId">;
  view: NativeImageView;
}
interface NativeImageStage {
  runtime: AgentRuntimeInternal;
  comparisonIdentity: string;
  assistantMessageId: string;
  modelKey: string;
  model: { providerId: string; modelId: string };
  sources: Map<string, string>;
  baseline: Map<string, string>;
  images: Map<string, FrozenImageReceipt>;
  omittedRefs: Set<string>;
  restores: Map<string, string>;
  signal?: AbortSignal;
  committed: boolean;
  committing?: Promise<void>;
}
const imageStages = new WeakMap<NativeContextImageReceipt[], NativeImageStage>();
function comparisonIdentity(comparison: NativeContextRequestComparison): string {
  return nativeHash(
    JSON.stringify([
      comparison.generation,
      comparison.historyVersion,
      comparison.policyVersion,
      comparison.segmentId,
      comparison.policy,
    ]),
  );
}
export function assertNativeImageBoundary(
  runtime: AgentRuntimeInternal,
  state: NativeContextStoredState,
  comparison: NativeContextRequestComparison,
): void {
  if (
    runtime.branchGeneration !== comparison.generation ||
    state.generation !== comparison.generation ||
    state.historyVersion !== comparison.historyVersion ||
    state.policy.policyVersion !== comparison.policyVersion ||
    state.compactBoundaryId !== comparison.segmentId ||
    nativeHash(JSON.stringify(state.policy)) !== nativeHash(JSON.stringify(comparison.policy))
  ) {
    throw new NativeContextRuntimeError("conflict", "image-boundary");
  }
}
export function stageNativeImageReceipts(
  runtime: AgentRuntimeInternal,
  receipts: NativeContextImageReceipt[],
  input: {
    comparison: NativeContextRequestComparison;
    assistantMessageId: string;
    modelKey: string;
    model: { providerId: string; modelId: string };
    sources: readonly NativeContextSource[];
    views: ReadonlyMap<string, NativeImageView>;
    omittedRefs: ReadonlySet<string>;
    restores: ReadonlyMap<string, string>;
    signal?: AbortSignal;
  },
): void {
  const images = new Map(
    receipts.map((receipt) => {
      const { logicalRequestId: _pending, ...identity } = receipt;
      return [receipt.ref, { receipt, identity, view: input.views.get(receipt.ref)! }] as const;
    }),
  );
  imageStages.set(receipts, {
    runtime,
    comparisonIdentity: comparisonIdentity(input.comparison),
    assistantMessageId: input.assistantMessageId,
    modelKey: input.modelKey,
    model: { ...input.model },
    sources: new Map(
      input.sources.map((source) => [source.ref, nativeImageSourceIdentity(source)]),
    ),
    baseline: new Map(
      input.comparison.baselineEntries.flatMap((entry) => {
        const raw = nativeRawId(entry);
        return raw ? [[raw, historyVersionOf([entry])]] : [];
      }),
    ),
    images,
    omittedRefs: new Set(input.omittedRefs),
    restores: new Map(input.restores),
    signal: input.signal,
    committed: false,
  });
}
function assertStageMembership(
  runtime: AgentRuntimeInternal,
  state: NativeContextStoredState,
  stage: NativeImageStage,
): void {
  const live = new Map(
    runtime.messageHistory.borrowReadOnlyRuntimeEntries().flatMap((entry) => {
      const raw = nativeRawId(entry);
      return raw ? [[raw, historyVersionOf([entry])]] : [];
    }),
  );
  for (const [raw, hash] of stage.baseline)
    if (live.get(raw) !== hash)
      throw new NativeContextRuntimeError("conflict", "image-branch-source");
  const sources = new Map(
    state.sources.map((source) => [source.ref, nativeImageSourceIdentity(source)]),
  );
  for (const [ref, identity] of stage.sources)
    if (sources.get(ref) !== identity)
      throw new NativeContextRuntimeError("conflict", "image-branch-source");
}
function validateReceipts(receipts: NativeContextImageReceipt[], stage: NativeImageStage): boolean {
  const seen = new Set<string>();
  for (const receipt of receipts) {
    const frozen = stage.images.get(receipt.ref);
    const { logicalRequestId, ...identity } = receipt;
    if (
      !frozen ||
      frozen.receipt !== receipt ||
      seen.has(receipt.ref) ||
      !nativeContextImageReceiptSchema.safeParse(receipt).success ||
      JSON.stringify(identity) !== JSON.stringify(frozen.identity)
    )
      throw new NativeContextRuntimeError("invalid-state", "image-receipt");
    if (logicalRequestId === "pending" || !logicalRequestId.trim()) return false;
    seen.add(receipt.ref);
  }
  return true;
}
async function completeAssistantExists(
  runtime: AgentRuntimeInternal,
  stage: NativeImageStage,
): Promise<boolean> {
  const message = await runtime.sessionStore!.messageWithParts({
    sessionID: runtime.sessionId,
    messageID: stage.assistantMessageId as MessageId,
  });
  if (
    !message ||
    // 回执证明必须来自本会话的实际响应；错误返回的 message/part 不能跨会话签发已看图状态。
    message.info.id !== stage.assistantMessageId ||
    message.info.sessionID !== runtime.sessionId ||
    message.info.role !== "assistant" ||
    message.info.error ||
    !Number.isFinite(message.info.time.completed) ||
    message.info.providerId + "/" + message.info.modelId !== stage.modelKey ||
    message.info.summary
  )
    return false;
  const failed = /error|cancel|abort|interrupt|discard|content[-_]filter/iu;
  if (failed.test(message.info.finish ?? "")) return false;
  return message.parts.some(
    (part) =>
      part.type === "step-finish" &&
      part.messageID === stage.assistantMessageId &&
      part.sessionID === runtime.sessionId &&
      !failed.test(part.reason),
  );
}
/** 完整成功响应落盘之后提交一次；CAS 与 restore 消费共用唯一 owner 写入口。 */
export function commitNativeImageReceipts(
  runtime: AgentRuntimeInternal,
  receipts: NativeContextImageReceipt[],
  comparison?: NativeContextRequestComparison,
): Promise<void> {
  const stage = imageStages.get(receipts);
  if (!stage) {
    if (receipts.length)
      return Promise.reject(new NativeContextRuntimeError("invalid-state", "image-staging"));
    return Promise.resolve();
  }
  if (stage.committed) return Promise.resolve();
  if (stage.committing) return stage.committing;
  const commit = async () => {
    if (
      stage.runtime !== runtime ||
      !comparison ||
      stage.comparisonIdentity !== comparisonIdentity(comparison)
    ) {
      throw new NativeContextRuntimeError("conflict", "image-staging");
    }
    if (
      stage.signal?.aborted ||
      !validateReceipts(receipts, stage) ||
      (!receipts.length && !stage.omittedRefs.size) ||
      !(await completeAssistantExists(runtime, stage))
    )
      return;
    const owner = nativeOwner(runtime);
    await owner.serial;
    assertNativeImageBoundary(runtime, owner.state!, comparison);
    assertStageMembership(runtime, owner.state!, stage);
    const facts = nativeImageCommitFacts(owner, {
      assistantMessageId: stage.assistantMessageId,
      model: stage.model,
      comparison,
      receipts,
      omittedRefs: stage.omittedRefs,
    });
    await writeNativeState(
      owner,
      (next) => {
        assertNativeImageBoundary(runtime, next, comparison);
        assertStageMembership(runtime, next, stage);
        const kernel = kernelOf(next);
        for (const receipt of receipts) {
          (kernel.imageViews ??= {})[receipt.ref] = structuredClone(
            stage.images.get(receipt.ref)!.view,
          );
          const duplicate = next.imageReceipts.some(
            (item) => JSON.stringify(item) === JSON.stringify(receipt),
          );
          if (!duplicate) next.imageReceipts.push({ ...receipt });
        }
        // 重新发送成功就是新的已提交视图；否则随后切 manual 会复活旧省略。
        // 仅删除最终 gate 保留且完整响应证明的 refs，准备/失败/未发送都不改持久 latch。
        const resent = new Set(receipts.map((receipt) => receipt.ref));
        kernel.omittedImageRefs = [
          ...new Set([
            ...(kernel.omittedImageRefs ?? []).filter((ref) => !resent.has(ref)),
            ...stage.omittedRefs,
          ]),
        ];
      },
      facts,
      () => {
        stage.committed = true;
        for (const receipt of receipts) {
          const restored = stage.restores.get(receipt.ref);
          if (restored) owner.restoreImageRefs?.delete(restored);
        }
      },
    );
  };
  stage.committing = commit().finally(() => {
    stage.committing = undefined;
  });
  return stage.committing;
}
