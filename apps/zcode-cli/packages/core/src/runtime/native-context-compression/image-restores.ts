import type { MessageId } from "@zcode/contracts";
import type { NativeContextStoredState } from "@zcode/shared/native-context-compression";
import type { NativeContextStateOwner } from "./state.js";
import type { NativeContextImagesRequest, NativeImageBinding } from "./image-contract.js";
import { nativeRawId } from "./identity.js";
import { nativeUserTurnStarts } from "./image-identity.js";

/** owner 的回取意图还须绑定真实完成工具的附件；相同 bytes 或外部 source.id 不能签发豁免。 */
export async function nativeRestoredImageRef(
  owner: NativeContextStateOwner,
  state: NativeContextStoredState,
  input: NativeContextImagesRequest,
  binding: NativeImageBinding,
  intents: ReadonlySet<string>,
): Promise<string | undefined> {
  const id = binding.block.source?.id,
    prefix = "context-original-";
  if (!id?.startsWith(prefix)) return undefined;
  const ref = id.slice(prefix.length);
  if (!intents.has(ref)) return undefined;
  const originalSource = state.sources.find(
    (source) => source.kind === "image" && source.ref === ref,
  );
  if (
    !originalSource?.originalAvailable ||
    originalSource.partId === binding.source.partId ||
    originalSource.artifactUri !== binding.original.artifactUri ||
    originalSource.contentHash !== binding.original.sha256 ||
    originalSource.originalBytes !== binding.bytes.byteLength
  )
    return undefined;
  const entries = input.comparison?.baselineEntries;
  if (!entries) return undefined;
  const entryIndex = entries.findIndex(
    (item) => nativeRawId(item) === binding.source.rawId.replace(/:image\d+$/u, ""),
  );
  const latestUser = nativeUserTurnStarts(entries).at(-1);
  // 根因：只按 ref 保存的回取意图会把失败轮的硬预算豁免带入新消息，导致后续文本请求持续失败。
  // 豁免绑定真实工具所在的 canonical 用户轮；同轮重试保留原字节，synthetic carrier 不创建新轮。
  if (latestUser === undefined || entryIndex <= latestUser) return undefined;
  const entry = entries[entryIndex];
  if (
    !entry ||
    entry.kind === "attachment" ||
    entry.message.role !== "tool" ||
    entry.message.toolName !== "context_read_image" ||
    entry.message.isError ||
    !entry.message.toolCallId
  )
    return undefined;
  const message = await owner.runtime.sessionStore!.messageWithParts({
    sessionID: owner.runtime.sessionId,
    messageID: binding.source.messageId as MessageId,
  });
  input.signal?.throwIfAborted();
  const part = message?.parts.find(
    (item) =>
      item.type === "tool" &&
      item.id === entry.canonical?.partId &&
      item.callID === entry.message.toolCallId &&
      item.tool === "context_read_image",
  );
  return part?.type === "tool" &&
    part.state.status === "completed" &&
    part.state.input.ref === ref &&
    part.state.attachments?.some((attachment) => attachment.id === binding.source.partId)
    ? ref
    : undefined;
}
