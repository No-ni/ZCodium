import type { ImagePrepareForModelRequest, ImagePrepareForModelResult } from "@zcode/contracts";
import type { NativeContextParameters } from "@zcode/shared/native-context-compression";

export type NativeContextImagePrepareRequest = ImagePrepareForModelRequest & {
  nativeContextPolicy: NativeContextParameters["images"];
};

/** 每个 adapter 实例拥有一个有界副本缓存；原字节与原图持久化由调用方持有。 */
export type NativeContextImagePreparer = (
  request: NativeContextImagePrepareRequest,
  options?: { signal?: AbortSignal },
) => Promise<ImagePrepareForModelResult>;
