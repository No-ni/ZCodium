import type { ZCodeProtocolMethod, ZCodeProtocolRequestId } from "@zcode/shared";
import type { V4Method } from "@zcode/shared/zcode-protocol-v4";

/** 客户端可发的方法名：旧 zcodeProtocolMethods + v4/*（并存，收敛为 v4）。 */
type ZCodeProtocolClientMethod = ZCodeProtocolMethod | V4Method;

class ZCodeProtocolClientError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "ZCodeProtocolClientError";
  }
}

export class ZCodeProtocolRequestTimeoutError extends Error {
  constructor(
    readonly method: ZCodeProtocolClientMethod,
    readonly requestId: ZCodeProtocolRequestId,
    readonly timeoutMs: number,
  ) {
    super(`ZCode Protocol request timed out: ${method}`);
    this.name = "ZCodeProtocolRequestTimeoutError";
  }
}
export { type ZCodeProtocolClientMethod, ZCodeProtocolClientError };
