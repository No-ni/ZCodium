import {
  READ_IMAGE_MAX_BASE64_BYTES,
  READ_IMAGE_TARGET_BYTES,
  type ImageProcessorPort,
  type SessionId,
  type ToolArtifactStorePort,
  type TraceContext,
  type TurnId,
} from "../deps.js";
import {
  originalImageToStorageMetadata,
  persistOriginalImage,
} from "../../media/original-image/index.js";
import { MAX_IMAGE_ATTACHMENT_DIMENSION } from "../types.js";
import type { PreparedImageData } from "../types.js";
import type { NativeContextParameters } from "@zcode/shared/native-context-compression";

export async function prepareImageDataUrl(
  dataUrl: string,
  mediaType: string,
  options: {
    abortSignal?: AbortSignal;
    imageProcessorPort?: ImageProcessorPort;
    nativeContextImages?: NativeContextParameters["images"];
    artifactStore?: ToolArtifactStorePort;
    sessionId?: SessionId;
    turnId?: TurnId;
    toolCallId?: string;
    traceContext: TraceContext;
  },
): Promise<PreparedImageData | undefined> {
  const base64Data = parseBase64DataUrlPayload(dataUrl);
  if (!base64Data) return undefined;
  const data = Buffer.from(base64Data, "base64");
  if (data.byteLength === 0) return undefined;
  const original = await persistOriginalImage({
    data,
    mediaType,
    sourceKind: "attachment",
    artifactStore: options.artifactStore,
    sessionId: options.sessionId,
    turnId: options.turnId,
    toolCallId: options.toolCallId ?? "attachment-image",
    toolName: "attachment:image",
    trace: options.traceContext,
    signal: options.abortSignal,
  });
  // 原生策略由最终请求投影执行；提前降采样会让 canonical 历史永久只剩旧副本。
  if (!original || !options.imageProcessorPort || options.nativeContextImages) {
    return {
      dataUrl,
      mediaType,
      metadata: originalImageToStorageMetadata(original?.originalImage),
    };
  }

  const prepared = await options.imageProcessorPort.prepareForModel(
    {
      data,
      maxBase64Bytes: READ_IMAGE_MAX_BASE64_BYTES,
      maxDimension: MAX_IMAGE_ATTACHMENT_DIMENSION,
      maxRawBytes: READ_IMAGE_TARGET_BYTES,
      mediaType,
      trace: options.traceContext,
    },
    { signal: options.abortSignal },
  );
  const resizedData = Buffer.from(prepared.data);
  const resizedMediaType = prepared.mediaType || mediaType;
  return {
    dataUrl: `data:${resizedMediaType};base64,${resizedData.toString("base64")}`,
    mediaType: resizedMediaType,
    metadata: {
      ...originalImageToStorageMetadata(original.originalImage),
      height: prepared.height,
      maxDimension: MAX_IMAGE_ATTACHMENT_DIMENSION,
      originalHeight: prepared.originalHeight,
      originalWidth: prepared.originalWidth,
      resized: prepared.resized,
      transformedSizeBytes: prepared.transformedSizeBytes,
      width: prepared.width,
    },
  };
}

function parseBase64DataUrlPayload(dataUrl: string): string | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/i.exec(dataUrl);
  const data = match?.[2];
  if (!match || !data) return undefined;
  return data;
}

export function inferImageMimeFromPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".bmp")) return "image/bmp";
  return "image/png";
}
