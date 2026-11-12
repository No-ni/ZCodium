import {
  nativeContextRecordRequestSchema,
  nativeContextPageRequestSchema,
  nativeContextSourceRequestSchema,
  nativeContextImageRequestSchema,
} from "@zcode/shared/native-context-compression";
import type {
  NativeContextSource,
  NativeContextSourceRequest,
  NativeContextImageRequest,
  NativeContextPageRequest,
  NativeContextRecordRequest,
} from "@zcode/shared/native-context-compression";
import type { AgentRuntimeInternal } from "../internal.js";
import type { MessageId, MessageWithParts, FilePart } from "@zcode/contracts";
import { createMessageHistory } from "../../agent/message-history.js";
import { hydrateMessageHistoryFromSession } from "../../agent/session-history-hydrator.js";
import { originalImageFromStorageMetadata } from "../../media/original-image/index.js";
import { NativeContextRuntimeError } from "./contract.js";
import { ensureNativeState, nativeOwner, kernelOf, type NativeContextStateOwner } from "./state.js";
import { nativeEntryText, nativeHash, nativeRawId } from "./identity.js";
import { nativeCountTokens } from "./measurements.js";

const IMAGE_CHUNK_BYTES = 512 * 1024;
const SOURCE_MAX_CHARS = 100_000;
export async function nativeReadOwner(
  runtime: AgentRuntimeInternal,
  expectedRevision?: number,
): Promise<NativeContextStateOwner> {
  const owner = nativeOwner(runtime);
  await ensureNativeState(owner);
  await owner.serial;
  if (
    owner.state!.generation !== runtime.branchGeneration ||
    (expectedRevision !== undefined && expectedRevision !== owner.state!.revision)
  ) {
    throw new NativeContextRuntimeError("stale-view", "revision");
  }
  return owner;
}
function viewOf(owner: NativeContextStateOwner) {
  const { revision, generation, historyVersion } = owner.state!;
  return { revision, generation, historyVersion };
}
function assertView(owner: NativeContextStateOwner, revision: number): void {
  if (
    owner.state!.revision !== revision ||
    owner.state!.generation !== owner.runtime.branchGeneration
  )
    throw new NativeContextRuntimeError("stale-view", "revision");
}
export function nativeSourceForRef(
  owner: NativeContextStateOwner,
  ref: string,
): NativeContextSource {
  const source = owner.state!.sources.find((item) => item.ref === ref);
  if (!source) throw new NativeContextRuntimeError("invalid-range", "unknown-ref");
  return source;
}
/** 来源须在当前会话的持久 message/part 中出现，fork 可合法持有祖先 artifact。 */
export function nativeOwnedImagePart(
  message: MessageWithParts | undefined | null,
  partId: string,
): FilePart | undefined {
  for (const part of message?.parts ?? []) {
    if (part.type === "file" && part.id === partId) return part;
    // Read/MCP 的图片附在完成的 ToolPart 中，不能只查顶层 FilePart 而误报原图丢失。
    if (part.type === "tool" && part.state.status === "completed") {
      const image = part.state.attachments?.find((attachment) => attachment.id === partId);
      if (image) return image;
    }
  }
  return undefined;
}
export async function ownedNativeImage(
  owner: NativeContextStateOwner,
  source: NativeContextSource,
  signal?: AbortSignal,
) {
  if (source.kind !== "image" || !source.originalAvailable || !source.artifactUri || !source.partId)
    return null;
  const runtime = owner.runtime;
  const message = await runtime.sessionStore!.messageWithParts({
    sessionID: runtime.sessionId,
    messageID: source.messageId as MessageId,
  });
  const part = nativeOwnedImagePart(message, source.partId);
  const original = originalImageFromStorageMetadata(
    part?.type === "file" ? part.metadata?.image : undefined,
  );
  if (
    !original ||
    original.artifactUri !== source.artifactUri ||
    original.sha256 !== source.contentHash
  )
    return null;
  const port = runtime.artifactStore;
  if (!port?.readToolResultBinaryArtifact) return null;
  const read = await port.readToolResultBinaryArtifact(
    { uri: source.artifactUri, trace: runtime.rootTraceContext },
    { signal },
  );
  return read.bytes.byteLength === original.bytes &&
    read.bytes.byteLength === source.originalBytes &&
    nativeHash(read.bytes) === source.contentHash
    ? { bytes: read.bytes, original }
    : null;
}
export async function ownedNativeImageBytes(
  owner: NativeContextStateOwner,
  source: NativeContextSource,
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  return (await ownedNativeImage(owner, source, signal))?.bytes ?? null;
}
export async function ownedNativeSourceText(
  owner: NativeContextStateOwner,
  source: NativeContextSource,
): Promise<string | null> {
  if (source.kind === "image") return null;
  const runtime = owner.runtime;
  const message = await runtime.sessionStore!.messageWithParts({
    sessionID: runtime.sessionId,
    messageID: source.messageId as MessageId,
  });
  if (!message || (source.partId && !message.parts.some((part) => part.id === source.partId)))
    return null;
  const callIndex = /:c(\d+)$/u.exec(source.rawId);
  const baseRawId = callIndex ? source.rawId.slice(0, callIndex.index) : source.rawId;
  const textOf = (
    entry: import("../../agent/message-history.js").RuntimeMessageEntry | undefined,
  ): string | null => {
    if (!entry) return null;
    if (!callIndex) return nativeEntryText(entry);
    const call =
      entry.kind !== "attachment" ? entry.message.toolCalls?.[Number(callIndex[1])] : undefined;
    return call ? JSON.stringify(call.input) : null;
  };
  const live = runtime.messageHistory
    .borrowReadOnlyRuntimeEntries()
    .find((item) => nativeRawId(item) === baseRawId);
  const liveText = textOf(live);
  if (liveText !== null && nativeHash(liveText) === source.contentHash) return liveText;
  const history = createMessageHistory();
  await hydrateMessageHistoryFromSession({
    history,
    messages: [message],
    artifactStore: runtime.artifactStore,
  });
  const entry = history
    .borrowReadOnlyRuntimeEntries()
    .find((item) => nativeRawId(item) === baseRawId);
  const text = textOf(entry);
  return text !== null && nativeHash(text) === source.contentHash ? text : null;
}
export async function listNativeContextObservations(
  this: AgentRuntimeInternal,
  input: Omit<NativeContextPageRequest, "sessionId">,
) {
  const request = nativeContextPageRequestSchema.parse({ ...input, sessionId: this.sessionId });
  const owner = await nativeReadOwner(this, request.expectedRevision);
  const view = viewOf(owner);
  const page = await this.sessionStore!.listNativeContextObservations!(this.sessionId, {
    ...input,
    expectedRevision: view.revision,
  });
  assertView(owner, view.revision);
  return page;
}
export async function listNativeContextRecords(
  this: AgentRuntimeInternal,
  input: Omit<NativeContextPageRequest, "sessionId">,
) {
  const request = nativeContextPageRequestSchema.parse({ ...input, sessionId: this.sessionId });
  const owner = await nativeReadOwner(this, request.expectedRevision);
  const view = viewOf(owner);
  const page = await this.sessionStore!.listNativeContextOperations!(this.sessionId, {
    ...input,
    expectedRevision: view.revision,
  });
  assertView(owner, view.revision);
  return page;
}
export async function readNativeContextRecord(
  this: AgentRuntimeInternal,
  input: Omit<NativeContextRecordRequest, "sessionId">,
) {
  const request = nativeContextRecordRequestSchema.parse({ ...input, sessionId: this.sessionId });
  const owner = await nativeReadOwner(this, request.expectedRevision);
  const view = viewOf(owner);
  const record = await this.sessionStore!.getNativeContextOperation!(
    this.sessionId,
    request.operationId,
  );
  assertView(owner, view.revision);
  if (!record) throw new NativeContextRuntimeError("invalid-range", "unknown-operation");
  const sourceCursor = request.sourceCursor ?? 0,
    sourceLimit = request.sourceLimit ?? 20;
  const summaryOffset = request.summaryOffset ?? 0,
    summaryLimit = request.summaryLimitChars ?? 20_000;
  const sources = record.sources.slice(sourceCursor, sourceCursor + sourceLimit);
  const summary = record.summary.slice(summaryOffset, summaryOffset + summaryLimit);
  return {
    ...record,
    sources,
    summary,
    sourceTotal: record.sources.length,
    nextSourceCursor:
      sourceCursor + sources.length < record.sources.length ? sourceCursor + sources.length : null,
    summaryOffset,
    summaryTotalChars: record.summary.length,
    nextSummaryOffset:
      summaryOffset + summary.length < record.summary.length
        ? summaryOffset + summary.length
        : null,
    revision: view.revision,
    viewGeneration: view.generation,
    viewHistoryVersion: view.historyVersion,
  };
}
export async function readNativeContextSource(
  this: AgentRuntimeInternal,
  input: Omit<NativeContextSourceRequest, "sessionId">,
) {
  const request = nativeContextSourceRequestSchema.parse({ ...input, sessionId: this.sessionId });
  const owner = await nativeReadOwner(this, request.expectedRevision);
  const view = viewOf(owner);
  const block = kernelOf(owner.state!).compression.blocks.find(
    (item) => item.blockId === request.ref,
  );
  const original = block
    ? block.summary
    : await ownedNativeSourceText(owner, nativeSourceForRef(owner, request.ref));
  assertView(owner, view.revision);
  const offset = request.offset ?? 0;
  const available = original !== null;
  let end = Math.min(original?.length ?? 0, offset + SOURCE_MAX_CHARS);
  const tokenLimit = request.limitTokens ?? owner.state!.policy.parameters.retrieval.textPageTokens;
  let low = Math.min(offset, end),
    high = end;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (nativeCountTokens(original!.slice(offset, mid)) > tokenLimit) high = mid - 1;
    else low = mid;
  }
  end = low;
  return {
    ref: request.ref,
    text: original?.slice(offset, end) ?? "",
    offset,
    nextOffset: original !== null && end < original.length ? end : null,
    originalAvailable: available,
    ...view,
  };
}
export async function readNativeContextImage(
  this: AgentRuntimeInternal,
  input: Omit<NativeContextImageRequest, "sessionId">,
) {
  const request = nativeContextImageRequestSchema.parse({ ...input, sessionId: this.sessionId });
  const owner = await nativeReadOwner(this, request.expectedRevision);
  const view = viewOf(owner),
    source = nativeSourceForRef(owner, request.ref);
  const proved = await ownedNativeImage(owner, source);
  const bytes = proved?.bytes ?? null;
  assertView(owner, view.revision);
  const offset = request.offset ?? 0;
  const end = Math.min(bytes?.byteLength ?? 0, offset + (request.maxBytes ?? IMAGE_CHUNK_BYTES));
  const mediaType = proved?.original.mediaType ?? null;
  assertView(owner, view.revision);
  return {
    ref: request.ref,
    dataUrl: null,
    dataBase64: bytes ? Buffer.from(bytes.subarray(offset, end)).toString("base64") : null,
    mediaType,
    offset,
    nextOffset: bytes && end < bytes.byteLength ? end : null,
    originalAvailable: bytes !== null,
    originalBytes: source.originalBytes,
    width: source.width,
    height: source.height,
    reason: bytes ? null : ("unavailable" as const),
    ...view,
  };
}
