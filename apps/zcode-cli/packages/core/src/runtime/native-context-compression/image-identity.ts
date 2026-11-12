import { parseImageDataUrl } from "@zcode/contracts";
import type { ModelImageContentBlock } from "@zcode/contracts";
import type {
  NativeContextImageReceipt,
  NativeContextSource,
  NativeContextStoredState,
} from "@zcode/shared/native-context-compression";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import { nativeHash, nativeRawId } from "./identity.js";
import { kernelOf } from "./state.js";
import type { NativeImageView } from "./image-contract.js";

/** 不按内容 hash 合并身份；重复内容的两个 FilePart 必须拥有两个独立 ref。 */
export function nativeImageSource(
  state: NativeContextStoredState,
  block: ModelImageContentBlock,
): NativeContextSource | undefined {
  const partId = block.source?.canonicalPartId;
  if (!partId) return undefined;
  const sources = state.sources.filter(
    (source) => source.kind === "image" && source.partId === partId,
  );
  return sources.length === 1 ? sources[0] : undefined;
}
export function nativeImageSourceIdentity(source: NativeContextSource): string {
  return JSON.stringify([
    source.rawId,
    source.ref,
    source.messageId,
    source.partId,
    source.entryIndex,
    source.imageIndex,
    source.contentHash,
    source.artifactUri,
    source.originalBytes,
  ]);
}
export function nativeImageBelongsToBaseline(
  source: NativeContextSource,
  block: ModelImageContentBlock,
  entries: readonly RuntimeMessageEntry[],
): boolean {
  const entry = entries.find(
    (item) => nativeRawId(item) === source.rawId.replace(/:image\d+$/u, ""),
  );
  if (
    !entry ||
    entry.kind === "attachment" ||
    !Array.isArray(entry.message.content) ||
    source.imageIndex === null
  )
    return false;
  const image = entry.message.content.filter((item) => item.type === "image")[source.imageIndex];
  const partId =
    entry.canonical?.imagePartIds?.[source.imageIndex] ?? image?.source?.canonicalPartId;
  if (!image || partId !== source.partId) return false;
  const sent = parseImageDataUrl(block.dataUrl)?.data,
    baseline = parseImageDataUrl(image.dataUrl)?.data;
  return Boolean(sent && baseline && nativeHash(sent) === nativeHash(baseline));
}
export function matchingNativeImageReceipt(
  state: NativeContextStoredState,
  source: NativeContextSource,
  representation: Pick<NativeImageView, "policyHash" | "representationHash">,
  modelKey?: string,
): NativeContextImageReceipt | undefined {
  return state.imageReceipts.findLast(
    (receipt) =>
      receipt.ref === source.ref &&
      receipt.generation === state.generation &&
      receipt.logicalRequestId !== "pending" &&
      Boolean(receipt.logicalRequestId.trim()) &&
      Boolean(receipt.responseMessageId.trim()) &&
      receipt.policyHash === representation.policyHash &&
      receipt.representationHash === representation.representationHash &&
      (modelKey === undefined || receipt.modelKey === modelKey),
  );
}
function currentImageWasReceived(
  state: NativeContextStoredState,
  source: NativeContextSource,
  block: ModelImageContentBlock,
): boolean {
  const view = kernelOf(state).imageViews?.[source.ref];
  if (view) return Boolean(matchingNativeImageReceipt(state, source, view));
  const data = parseImageDataUrl(block.dataUrl)?.data;
  const hash = data ? nativeHash(data) : source.contentHash;
  return state.imageReceipts.some(
    (receipt) =>
      receipt.ref === source.ref &&
      receipt.generation === state.generation &&
      receipt.logicalRequestId !== "pending" &&
      Boolean(receipt.logicalRequestId.trim()) &&
      receipt.representationHash === hash,
  );
}
/** 同步候选保护只用持久来源与已提交回执；最终发送仍须异步验证真实 FilePart/原 bytes。 */
export function nativeImageHardProtectedGroups(
  entries: readonly RuntimeMessageEntry[],
  state: NativeContextStoredState,
): Set<string> {
  const protectedGroups = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "attachment" || !entry.canonical || !Array.isArray(entry.message.content))
      continue;
    let imageIndex = 0;
    for (const block of entry.message.content) {
      if (block.type !== "image") continue;
      const rawId = nativeRawId(entry) + ":image" + imageIndex;
      const partId = entry.canonical.imagePartIds?.[imageIndex] ?? block.source?.canonicalPartId;
      const source = state.sources.find(
        (item) => item.kind === "image" && item.rawId === rawId && item.partId === partId,
      );
      if (
        !source?.originalAvailable ||
        !source.artifactUri ||
        !partId ||
        block.source?.originalImage?.preserveRaster ||
        !currentImageWasReceived(state, source, block)
      ) {
        protectedGroups.add(entry.canonical.messageId);
      }
      imageIndex++;
    }
  }
  return protectedGroups;
}
/** 只按真实 user 的 distinct canonical message 计轮，工具结果与 synthetic carrier 不计轮。 */
export function nativeUserTurnStarts(entries: readonly RuntimeMessageEntry[]): number[] {
  const seen = new Set<string>(),
    starts: number[] = [];
  entries.forEach((entry, index) => {
    if (
      entry.kind === "attachment" ||
      entry.message.role !== "user" ||
      (entry.metadata && entry.metadata.source !== "real_user") ||
      !entry.canonical
    )
      return;
    if (!seen.has(entry.canonical.messageId)) {
      seen.add(entry.canonical.messageId);
      starts.push(index);
    }
  });
  return starts;
}
export function nativeRecentImageGroups(
  entries: readonly RuntimeMessageEntry[],
  turns: number,
): Set<string> {
  const starts = nativeUserTurnStarts(entries);
  const start = starts.at(-Math.max(1, turns)) ?? starts[0] ?? 0;
  return new Set(
    entries.slice(start).flatMap((entry) => (entry.canonical ? [entry.canonical.messageId] : [])),
  );
}
