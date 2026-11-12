import { activeBlocks, type CompressionBlock } from "acp-kernel";
import { isDeepStrictEqual } from "node:util";
import type {
  ModelImageContentBlock,
  ModelMessageContent,
  ModelReasoningContentBlock,
} from "@zcode/contracts";
import type { NativeContextStoredState } from "@zcode/shared/native-context-compression";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import { nativeMessageId } from "./guards.js";
import { nativeRawId } from "./identity.js";
import { kernelOf } from "./state.js";
import { NativeContextRuntimeError } from "./contract.js";
import { nativeProjectionOperations } from "./projection-operations.js";

/** baseline 与 after 共用真实图片身份；不得按内容 hash 或相邻位置猜 FilePart。 */
export function nativeEntriesWithImageIdentity(
  entries: readonly RuntimeMessageEntry[],
): RuntimeMessageEntry[] {
  return entries.map((entry) => {
    if (entry.kind === "attachment" || !entry.canonical || !Array.isArray(entry.message.content))
      return entry;
    let imageIndex = 0,
      changed = false;
    const content = entry.message.content.map((block) => {
      if (block.type !== "image") return block;
      const partId = entry.canonical!.imagePartIds?.[imageIndex++];
      if (!partId) return block;
      if (block.source?.canonicalPartId && block.source.canonicalPartId !== partId) {
        throw new NativeContextRuntimeError("invalid-state", "image-identity");
      }
      if (block.source?.canonicalPartId === partId) return block;
      changed = true;
      return {
        ...block,
        source: {
          ...(block.source ?? { id: partId, kind: "resource" as const }),
          canonicalPartId: partId,
        },
      };
    });
    return changed ? { ...entry, message: { ...entry.message, content } } : entry;
  });
}

/** 仅构造 Provider 副本；canonical 内容、parts 与来源不被原地改写。 */
export function projectNativeEntries(
  entries: readonly RuntimeMessageEntry[],
  state: NativeContextStoredState,
): RuntimeMessageEntry[] {
  return projectNativeRequest(entries, state).entries;
}

export function projectNativeRequest(
  entries: readonly RuntimeMessageEntry[],
  state: NativeContextStoredState,
): { entries: RuntimeMessageEntry[]; operationIds: string[] } {
  const kernel = kernelOf(state);
  const operations = nativeProjectionOperations(state);
  const operationIds = new Set<string>();
  const covering = new Map<string, CompressionBlock>();
  for (const block of activeBlocks(kernel.compression))
    for (const id of block.effectiveMessageIds) covering.set(nativeMessageId(id), block);
  const inserted = new Set<string>();
  const result: RuntimeMessageEntry[] = [];
  const sources = new Map(state.sources.map((source) => [source.rawId, source]));
  for (const entry of nativeEntriesWithImageIdentity(entries)) {
    const rawId = nativeRawId(entry);
    const block = entry.canonical ? covering.get(entry.canonical.messageId) : undefined;
    if (block && entry.kind !== "attachment") {
      if (!inserted.has(block.blockId)) {
        const summary = state.policy.parameters.prompts.visibilityMarkers
          ? "[Context summary " + block.blockId + "]\n" + block.summary
          : block.summary;
        result.push({
          message: { role: "user", content: summary },
          metadata: { source: "legacy_synthetic" },
        });
        inserted.add(block.blockId);
        const id = operations?.blocks[block.blockId];
        if (id) operationIds.add(id);
      }
      // 摘要覆盖 text/call 后仍保留精确图片 carrier，由最终异步策略判断；不留下 dangling tool result。
      const images = Array.isArray(entry.message.content)
        ? entry.message.content.filter(
            (item): item is ModelImageContentBlock => item.type === "image",
          )
        : [];
      if (images.length)
        result.push({
          ...entry,
          message: { role: "user", content: images },
          metadata: { source: "legacy_synthetic" },
        });
      continue;
    }
    if (entry.kind === "attachment" || !rawId) {
      result.push(entry);
      continue;
    }
    const source = sources.get(rawId);
    const view = kernel.views[rawId];
    let content: ModelMessageContent = view
      ? typeof entry.message.content === "string"
        ? view.text
        : [
            { type: "text", text: view.text },
            ...entry.message.content.filter((item) => item.type !== "text"),
          ]
      : entry.message.content;
    // 仅记录这次确实改变发送内容的视图；标记开销不能让未生效关系变成有效转换。
    if (view && !isDeepStrictEqual(content, entry.message.content)) {
      const id = operations?.views[rawId];
      if (id) operationIds.add(id);
    }
    if (Array.isArray(content) && kernel.omittedReasoningIds?.includes(rawId)) {
      // 已提交省略是投影视图；后来关闭 auto 或改阈值不得让旧推理正文重新出现。
      content = content.filter((item) => item.type !== "reasoning" || !canOmitReasoning(item));
    }
    if (
      source &&
      state.policy.parameters.prompts.visibilityMarkers &&
      (state.policy.mode === "auto" || view || covering.size)
    ) {
      const time = state.policy.parameters.prompts.messageTimestamps
        ? ` time="${new Date(source.firstSeenAt).toISOString()}"`
        : "";
      const marker = `[context ref=${source.ref} tokens=${source.tokenSnapshot}${time}]`;
      content =
        typeof content === "string"
          ? `${marker}\n${content}`
          : [{ type: "text", text: marker }, ...content];
    }
    result.push(
      content === entry.message.content
        ? entry
        : { ...entry, message: { ...entry.message, content } },
    );
  }
  return { entries: result, operationIds: [...operationIds] };
}
function canOmitReasoning(block: ModelReasoningContentBlock): boolean {
  return !block.providerOptions || Object.keys(block.providerOptions).length === 0;
}
