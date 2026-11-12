import type { NativeContextPageRequest } from "@zcode/shared/native-context-compression";
import { V4_METHODS } from "@zcode/shared/zcode-protocol-v4";
import type { NativeContextQueryMethod } from "./contract.js";

export const nativeContextBootstrapExample = {
  method: V4_METHODS.contextCompressionObservations satisfies NativeContextQueryMethod,
  params: {
    sessionId: "synthetic-task",
    purpose: "main",
    limit: 50,
  } satisfies NativeContextPageRequest,
} as const;
