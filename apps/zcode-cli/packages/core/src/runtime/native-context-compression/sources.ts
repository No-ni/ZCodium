import { assignRefs, highestUsedIndex, type CoreMessage } from "acp-kernel";
import { parseImageDataUrl } from "@zcode/contracts";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type {
  NativeContextSource,
  NativeContextStoredState,
} from "@zcode/shared/native-context-compression";
import { kernelOf } from "./state.js";
import { nativeHash, nativeRawId, nativeEntryText, historyVersionOf } from "./identity.js";
export { nativeHash, nativeRawId, nativeEntryText, historyVersionOf } from "./identity.js";
export function coreMessagesOf(
  entries: readonly RuntimeMessageEntry[],
  state?: NativeContextStoredState,
): CoreMessage[] {
  const sources = new Map(state?.sources.map((source) => [source.rawId, source]));
  return entries.flatMap((entry): CoreMessage[] => {
    const rawId = nativeRawId(entry);
    if (!rawId || entry.kind === "attachment") return [];
    const source = sources.get(rawId);
    const core: CoreMessage = {
      id: rawId,
      role: entry.message.role,
      contentType: entry.message.role === "tool" ? "tool-result" : "text",
      text: nativeEntryText(entry),
      ...(entry.message.toolName ? { toolName: entry.message.toolName } : {}),
      ...(entry.message.toolCallId ? { toolCallId: entry.message.toolCallId } : {}),
      ...(source ? { ts: source.firstSeenAt } : { ts: entry.canonical?.createdAt }),
    };
    return [
      core,
      ...(entry.message.toolCalls ?? []).map(
        (call, callIndex): CoreMessage => ({
          id: `${rawId}:c${callIndex}`,
          role: "assistant",
          contentType: "tool-call",
          text: JSON.stringify(call.input),
          toolName: call.name,
          toolCallId: call.id,
          ts: core.ts,
        }),
      ),
    ];
  });
}
/** firstSeenAt/tokenSnapshot 只在真实 canonical 身份首次出现时写入。 */
export function syncNativeSources(
  state: NativeContextStoredState,
  entries: readonly RuntimeMessageEntry[],
  countTokens: (text: string) => number,
): void {
  const known = new Map(state.sources.map((source) => [source.rawId, source]));
  const cores = coreMessagesOf(entries, state);
  const kernel = kernelOf(state);
  const assign = (messages: CoreMessage[]) => {
    const assigned = assignRefs(messages, {
      existing: kernel.compression.messageRefs,
      nextIndex:
        Math.max(highestUsedIndex(kernel.compression.messageRefs), kernel.refHighWaterIndex ?? 0) +
        1,
    });
    kernel.compression.messageRefs = assigned.map;
    kernel.refHighWaterIndex = Math.max(
      kernel.refHighWaterIndex ?? 0,
      highestUsedIndex(assigned.map),
    );
  };
  assign(cores);
  for (const entry of entries) {
    const rawId = nativeRawId(entry);
    const canonical = entry.canonical;
    if (!rawId || !canonical || entry.kind === "attachment") continue;
    if (!known.has(rawId)) {
      const text = nativeEntryText(entry);
      const source: NativeContextSource = {
        rawId,
        ref: kernel.compression.messageRefs.byRaw[rawId]!,
        messageId: canonical.messageId,
        partId: canonical.partId ?? null,
        entryIndex: canonical.entryIndex,
        imageIndex: null,
        kind: entry.message.role === "tool" ? "tool-result" : "text",
        sourceKind: "other",
        contentHash: nativeHash(text),
        artifactUri: null,
        originalAvailable: true,
        originalBytes: null,
        width: null,
        height: null,
        firstSeenAt: canonical.createdAt,
        tokenSnapshot: countTokens(text),
      };
      state.sources.push(source);
      known.set(rawId, source);
      kernel.compression.tokenSnapshot[source.ref] = source.tokenSnapshot;
    }
    for (let callIndex = 0; callIndex < (entry.message.toolCalls?.length ?? 0); callIndex++) {
      const call = entry.message.toolCalls![callIndex]!,
        callRawId = `${rawId}:c${callIndex}`;
      if (known.has(callRawId)) continue;
      const text = JSON.stringify(call.input);
      const source: NativeContextSource = {
        rawId: callRawId,
        ref: kernel.compression.messageRefs.byRaw[callRawId]!,
        messageId: canonical.messageId,
        partId: canonical.partId ?? null,
        entryIndex: canonical.entryIndex,
        imageIndex: null,
        kind: "tool-call",
        sourceKind: "other",
        contentHash: nativeHash(text),
        artifactUri: null,
        originalAvailable: true,
        originalBytes: null,
        width: null,
        height: null,
        firstSeenAt: canonical.createdAt,
        tokenSnapshot: countTokens(text),
      };
      state.sources.push(source);
      known.set(callRawId, source);
      kernel.compression.tokenSnapshot[source.ref] = source.tokenSnapshot;
    }
    if (!Array.isArray(entry.message.content)) continue;
    let imageIndex = 0;
    for (const block of entry.message.content) {
      if (block.type !== "image") continue;
      const imageRawId = `${rawId}:image${imageIndex}`;
      const partId = canonical.imagePartIds?.[imageIndex] ?? block.source?.canonicalPartId;
      const bytes = parseImageDataUrl(block.dataUrl)?.data;
      if (!known.has(imageRawId)) {
        assign([{ id: imageRawId, role: entry.message.role, contentType: "text" }]);
        const original = block.source?.originalImage;
        const source: NativeContextSource = {
          rawId: imageRawId,
          ref: kernel.compression.messageRefs.byRaw[imageRawId]!,
          messageId: canonical.messageId,
          partId: partId ?? canonical.partId ?? null,
          entryIndex: canonical.entryIndex,
          imageIndex,
          kind: "image",
          sourceKind:
            original?.sourceKind === "browser"
              ? "mcp"
              : (original?.sourceKind ?? (entry.message.role === "user" ? "attachment" : "other")),
          contentHash: original?.sha256 ?? nativeHash(bytes ?? block.dataUrl),
          artifactUri: original?.artifactUri ?? null,
          originalAvailable: Boolean(original?.artifactUri && partId),
          originalBytes: original?.bytes ?? null,
          width: original?.width ?? null,
          height: original?.height ?? null,
          firstSeenAt: canonical.createdAt,
          tokenSnapshot: 0,
        };
        state.sources.push(source);
        known.set(imageRawId, source);
      }
      imageIndex++;
    }
  }
  state.historyVersion = historyVersionOf(entries);
}
