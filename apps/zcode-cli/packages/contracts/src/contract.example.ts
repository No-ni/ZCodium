import { createModelId, createModelUsageSummary } from "./contract.js";
import type { ModelTextRequest } from "./contract.js";

/** 只准备 SDK 值；实际请求、权限与持久化由调用方通过现有端口执行。 */
export function prepareExampleRequest(): {
  modelId: ReturnType<typeof createModelId>;
  request: ModelTextRequest;
} {
  return {
    modelId: createModelId("example-model"),
    request: { messages: [{ role: "user", content: "Example" }] },
  };
}

export const exampleUsage = createModelUsageSummary([{ inputTokens: 5, outputTokens: 2 }]);
