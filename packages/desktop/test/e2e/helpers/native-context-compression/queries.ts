import { createHash } from "node:crypto";
import { ServiceChannels } from "@zcode/shared";
import {
  nativeContextImageSchema,
  nativeContextObservationsPageSchema,
  nativeContextOperationDetailSchema,
  nativeContextRecordsPageSchema,
  nativeContextSourcePageSchema,
  nativeContextStatusSchema,
  type NativeContextImage,
  type NativeContextPageRequest,
  type NativeContextRecordRequest,
  type NativeContextStatus,
} from "@zcode/shared/native-context-compression";
import { DEFAULT_WORKSPACE } from "../desktop-app.js";
import { callHandoffHost } from "../remote-project-handoff-probe.js";
import { getV4ConversationState } from "../v4-conversation.js";

export interface NativeContextTestTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
}

export async function nativeContextCurrentTarget(): Promise<NativeContextTestTarget> {
  const { sessionId } = await getV4ConversationState();
  if (!sessionId || sessionId === "draft")
    throw new Error("NCTX requires an admitted real CLI session");
  return { workspacePath: DEFAULT_WORKSPACE, sessionId };
}

const query = (target: NativeContextTestTarget, name: string, options: object = {}) =>
  callHandoffHost(ServiceChannels.ZCodeAgent, name, [{ ...target, ...options }]);

export async function getNativeContextStatus(target: NativeContextTestTarget) {
  return nativeContextStatusSchema.parse(await query(target, "getContextCompression"));
}
export async function listNativeContextObservations(
  target: NativeContextTestTarget,
  status: NativeContextStatus,
  options: Omit<NativeContextPageRequest, "sessionId" | "expectedRevision"> = {},
) {
  return nativeContextObservationsPageSchema.parse(
    await query(target, "listContextObservations", {
      ...options,
      expectedRevision: status.revision,
    }),
  );
}
export async function listNativeContextRecords(
  target: NativeContextTestTarget,
  status: NativeContextStatus,
  options: Omit<NativeContextPageRequest, "sessionId" | "expectedRevision"> = {},
) {
  return nativeContextRecordsPageSchema.parse(
    await query(target, "listContextCompressionRecords", {
      ...options,
      expectedRevision: status.revision,
    }),
  );
}
export async function readNativeContextRecord(
  target: NativeContextTestTarget,
  status: NativeContextStatus,
  operationId: string,
  options: Omit<NativeContextRecordRequest, "sessionId" | "operationId" | "expectedRevision"> = {},
) {
  return nativeContextOperationDetailSchema.parse(
    await query(target, "readContextCompressionRecord", {
      ...options,
      operationId,
      expectedRevision: status.revision,
    }),
  );
}
export async function readNativeContextSource(
  target: NativeContextTestTarget,
  status: NativeContextStatus,
  ref: string,
  offset = 0,
) {
  return nativeContextSourcePageSchema.parse(
    await query(target, "readContextSource", {
      ref,
      offset,
      limitTokens: 25000,
      expectedRevision: status.revision,
    }),
  );
}
export async function readNativeContextImageChunk(
  target: NativeContextTestTarget,
  status: NativeContextStatus,
  ref: string,
  offset = 0,
) {
  return nativeContextImageSchema.parse(
    await query(target, "readContextImage", {
      ref,
      offset,
      maxBytes: 512 * 1024,
      expectedRevision: status.revision,
    }),
  );
}

export async function readNativeContextOriginalImage(
  target: NativeContextTestTarget,
  status: NativeContextStatus,
  ref: string,
) {
  const chunks: Buffer[] = [];
  const pages: NativeContextImage[] = [];
  let offset = 0;
  let originalBytes: number | null = null;
  let mediaType: string | null = null;
  do {
    const page = await readNativeContextImageChunk(target, status, ref, offset);
    if (
      !page.originalAvailable ||
      !page.dataBase64 ||
      page.ref !== ref ||
      page.offset !== offset ||
      page.revision !== status.revision ||
      page.generation !== status.generation ||
      page.historyVersion !== status.historyVersion
    )
      throw new Error("NCTX original image read did not preserve source identity and version");
    originalBytes ??= page.originalBytes;
    mediaType ??= page.mediaType;
    if (page.originalBytes !== originalBytes || page.mediaType !== mediaType)
      throw new Error("NCTX image chunks disagree about original metadata");
    const chunk = Buffer.from(page.dataBase64, "base64");
    if (!chunk.length || chunk.length > 512 * 1024 || offset + chunk.length > 32 * 1024 * 1024)
      throw new Error("NCTX invalid bounded image chunk");
    chunks.push(chunk);
    pages.push(page);
    offset += chunk.length;
    if (page.nextOffset === null) break;
    if (page.nextOffset !== offset) throw new Error("NCTX noncontiguous original image page");
  } while (pages.length < 65);
  if (pages.at(-1)?.nextOffset !== null || originalBytes !== offset)
    throw new Error("NCTX incomplete original image");
  const bytes = Buffer.concat(chunks);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), pages, mediaType };
}
