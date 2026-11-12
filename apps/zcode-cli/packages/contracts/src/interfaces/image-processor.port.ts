import type { TraceContext } from "../tracing/tracer.js";
import type {
  NativeContextImageSourceKind,
  NativeContextParameters,
} from "@zcode/shared/native-context-compression";

export interface ImageResizeRequest {
  data: Uint8Array;
  mediaType: string;
  maxDimension: number;
  trace?: TraceContext;
}

export interface ImageResizeResult {
  data: Uint8Array;
  mediaType: string;
  originalWidth?: number;
  originalHeight?: number;
  width?: number;
  height?: number;
  resized: boolean;
}

export type ImageProcessorErrorCode =
  | "empty"
  | "invalid_request"
  | "processing_failed"
  | "too_large"
  | "unsupported";

export interface ImageProcessorErrorDetails {
  code: ImageProcessorErrorCode;
  message: string;
  cause?: unknown;
}

export class ImageProcessorPortError extends Error {
  readonly code: ImageProcessorErrorCode;
  override readonly cause?: unknown;

  constructor(details: ImageProcessorErrorDetails) {
    super(details.message);
    this.name = "ImageProcessorPortError";
    this.code = details.code;
    this.cause = details.cause;
  }
}

export function createImageProcessorError(
  details: ImageProcessorErrorDetails,
): ImageProcessorPortError {
  return new ImageProcessorPortError(details);
}

export function isImageProcessorPortError(error: unknown): error is ImageProcessorPortError {
  return error instanceof ImageProcessorPortError;
}

export type ImageCompressionStrategy =
  | "original"
  | "preserve-format"
  | "png-optimized"
  | "png-quantized"
  | "resized"
  | "jpeg-quality"
  | "jpeg-fallback";

export interface ImagePrepareForModelRequest extends ImageResizeRequest {
  maxBase64Bytes: number;
  maxRawBytes: number;
  maxTokens?: number;
  tokenToBase64CharRatio?: number;
  /** 原生压缩直接从本次收到的原字节应用策略，不先经过旧固定质量链。 */
  nativeContextPolicy?: NativeContextParameters["images"];
  sourceKind?: NativeContextImageSourceKind;
  /** 调用方冻结的目标模型/编码能力标识，参与发送副本缓存隔离。 */
  targetCapabilityKey?: string;
}

export interface ImagePrepareForModelResult extends ImageResizeResult {
  compressed: boolean;
  originalSizeBytes: number;
  strategy: ImageCompressionStrategy;
  transformedSizeBytes: number;
  /** 实际 JPEG 编码质量；原字节透传及无损格式不伪造质量读数。 */
  quality?: number;
  /** 原图由调用 owner 在处理前冻结；编码器不创建或推断原图来源。 */
  originalArtifactUri?: string;
  originalSha256?: string;
  originalMediaType?: string;
}

export interface ImageProcessorPort {
  resizeToFit(
    request: ImageResizeRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ImageResizeResult>;
  prepareForModel(
    request: ImagePrepareForModelRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ImagePrepareForModelResult>;
}
