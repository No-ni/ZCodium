import {
  CoreErrorType,
  READ_IMAGE_MAX_BASE64_BYTES,
  READ_IMAGE_MAX_DIMENSION,
  READ_IMAGE_MAX_INPUT_BYTES,
  READ_IMAGE_TARGET_BYTES,
  READ_IMAGE_TOKEN_TO_BASE64_CHAR_RATIO,
  READ_MAX_OUTPUT_TOKENS,
  createCoreError,
  isFileSystemPortError,
  isImageProcessorPortError,
  type ReadImageOutput,
  type TraceContext,
} from "@zcode/contracts";
import type { ToolExecutionContext } from "../types.js";
import { persistOriginalImage } from "../../media/original-image/index.js";

type SupportedReadImageMime = ReadImageOutput["mimeType"];

export async function readImageFile(
  filePath: string,
  mimeType: SupportedReadImageMime,
  context: ToolExecutionContext,
): Promise<ReadImageOutput> {
  const fileSystemPort = context.fileSystemPort;
  if (!fileSystemPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "FileSystemPort is not configured for Read tool",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "Read",
        },
        recoverable: false,
      },
    );
  }
  const trace = createToolTrace(context);
  let read;
  try {
    read = await fileSystemPort.readBinaryFile(
      {
        path: filePath,
        maxBytes: READ_IMAGE_MAX_INPUT_BYTES,
        trace,
      },
      { signal: context.abortSignal },
    );
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "too_large") {
      throw createCoreError(CoreErrorType.ToolExecutionFailed, error.message, {
        cause: error,
        context: {
          code: "read_image_input_too_large",
          filePath,
          maxBytes: READ_IMAGE_MAX_INPUT_BYTES,
          toolCallId: context.toolCallId,
          toolName: "Read",
        },
        recoverable: true,
      });
    }
    throw error;
  }

  if (read.content.byteLength === 0) {
    throw createCoreError(CoreErrorType.ToolExecutionFailed, "Image file is empty", {
      context: { code: "read_image_empty", toolCallId: context.toolCallId, toolName: "Read" },
      recoverable: true,
    });
  }
  const original = await persistOriginalImage({
    data: read.content,
    mediaType: mimeType,
    sourceKind: "read",
    artifactStore: context.artifactStore,
    sessionId: context.sessionId,
    turnId: context.turnId,
    toolCallId: context.toolCallId,
    toolName: "Read",
    trace,
    signal: context.abortSignal,
  });
  // 原生策略在最终请求才处理副本；未配置持久化也保原 bytes，避免伪造可恢复原图。
  if (!original || !context.imageProcessorPort || context.nativeContextCompression) {
    return {
      type: "image",
      base64: Buffer.from(read.content).toString("base64"),
      mimeType,
      originalSize: read.content.byteLength,
      originalImage: original?.originalImage,
    };
  }

  try {
    const prepared = await context.imageProcessorPort.prepareForModel(
      {
        data: read.content,
        maxBase64Bytes: READ_IMAGE_MAX_BASE64_BYTES,
        maxDimension: READ_IMAGE_MAX_DIMENSION,
        maxRawBytes: READ_IMAGE_TARGET_BYTES,
        maxTokens: READ_MAX_OUTPUT_TOKENS,
        mediaType: mimeType,
        tokenToBase64CharRatio: READ_IMAGE_TOKEN_TO_BASE64_CHAR_RATIO,
        trace,
      },
      { signal: context.abortSignal },
    );
    const outputMimeType = isSupportedImageMime(prepared.mediaType) ? prepared.mediaType : mimeType;

    return {
      type: "image",
      base64: Buffer.from(prepared.data).toString("base64"),
      mimeType: outputMimeType,
      originalSize: read.sizeBytes,
      originalImage: {
        ...original.originalImage,
        ...(prepared.originalWidth !== undefined ? { width: prepared.originalWidth } : {}),
        ...(prepared.originalHeight !== undefined ? { height: prepared.originalHeight } : {}),
      },
      transformedSize: prepared.transformedSizeBytes,
      resized: prepared.resized,
      compressed: prepared.compressed,
      compressionStrategy: prepared.strategy,
      dimensions: {
        originalWidth: prepared.originalWidth,
        originalHeight: prepared.originalHeight,
        displayWidth: prepared.width,
        displayHeight: prepared.height,
      },
    };
  } catch (error) {
    if (isImageProcessorPortError(error)) {
      throw createCoreError(CoreErrorType.ToolExecutionFailed, error.message, {
        cause: error,
        context: {
          code: `read_image_${error.code}`,
          filePath,
          maxBase64Bytes: READ_IMAGE_MAX_BASE64_BYTES,
          maxDimension: READ_IMAGE_MAX_DIMENSION,
          maxInputBytes: READ_IMAGE_MAX_INPUT_BYTES,
          maxRawBytes: READ_IMAGE_TARGET_BYTES,
          maxTokens: READ_MAX_OUTPUT_TOKENS,
          toolCallId: context.toolCallId,
          toolName: "Read",
        },
        recoverable: true,
      });
    }
    throw error;
  }
}

export function inferImageMimeFromPath(path: string): SupportedReadImageMime | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return undefined;
}

function isSupportedImageMime(value: string): value is SupportedReadImageMime {
  return (
    value === "image/jpeg" ||
    value === "image/png" ||
    value === "image/gif" ||
    value === "image/webp"
  );
}

function createToolTrace(context: ToolExecutionContext): TraceContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
  } as unknown as TraceContext;
}
