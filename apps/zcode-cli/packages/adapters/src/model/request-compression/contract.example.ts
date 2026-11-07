/**
 * 标准调用示例：把压缩层包在已有传输层之外，并按渠道复用同一份降级记忆。
 */
import { createRequestCompressionFetch } from "./index.js";
import type { RequestCompressionState } from "./contract.js";

export function exampleRunProviderRequestWithCompression(
  innerFetch: typeof globalThis.fetch,
  state: RequestCompressionState,
): typeof globalThis.fetch {
  return createRequestCompressionFetch({
    fetch: innerFetch,
    providerId: "demo-provider",
    algorithm: "brotli",
    state,
  });
}
