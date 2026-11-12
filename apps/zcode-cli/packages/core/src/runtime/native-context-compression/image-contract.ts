import type {
  Model,
  ModelImageContentBlock,
  ModelInputMessage,
  TraceContext,
} from "@zcode/contracts";
import type {
  NativeContextImageReceipt,
  NativeContextParameters,
  NativeContextSource,
} from "@zcode/shared/native-context-compression";
import type { NativeContextRequestComparison } from "./contract.js";
import type { NativeKernelData } from "./state.js";
import type { OriginalImageProvenance } from "../../media/original-image/index.js";

export type NativeImagePolicy = NativeContextParameters["images"];
export type NativeImageView = NonNullable<NativeKernelData["imageViews"]>[string];
export interface NativeImageLimits {
  maxRawBytes: number;
  maxBase64Bytes: number;
  maxDimension: number;
}
export interface NativeContextImagesRequest extends Partial<NativeImageLimits> {
  messages: ModelInputMessage[];
  model: Model;
  assistantMessageId: string;
  comparison?: NativeContextRequestComparison;
  traceContext: TraceContext;
  signal?: AbortSignal;
}
export interface NativeContextImageChanges {
  omittedRefs: string[];
  foldedRefs: string[];
  resizedRefs: string[];
  restoredRefs: string[];
}
export interface NativeContextImagesResult {
  messages: ModelInputMessage[];
  /** Tracker 原地填真实 logicalRequestId，最终媒体 gate 原地过滤；数组身份用于 attempt staging。 */
  sentImages: NativeContextImageReceipt[];
  imageChanges: NativeContextImageChanges;
}
export interface NativeImageBinding {
  block: ModelImageContentBlock;
  source: NativeContextSource;
  original: OriginalImageProvenance;
  bytes: Uint8Array;
  restoredRef?: string;
}
export interface NativeImageRepresentation {
  block: ModelImageContentBlock;
  view: NativeImageView;
  annotation?: string;
  resized: boolean;
}
