import type { NativeContextImagePreparer, NativeContextImagePrepareRequest } from "./contract.js";

/** 来源 owner 已冻结原图；策略编码器只返回本次模型请求的发送副本。 */
export async function nativeContextImageExample(
  prepare: NativeContextImagePreparer,
  request: NativeContextImagePrepareRequest,
  signal?: AbortSignal,
): Promise<number> {
  const result = await prepare(request, { signal });
  return result.transformedSizeBytes;
}
