import type { DynamicWorkflowClientConfig } from "@zcode/shared";
import { resolveDynamicWorkflowClientConfig } from "@zcode/shared";
import type { ICodingPlanSubscriptionService } from "./codingPlanSubscription.js";

/**
 * 动态工作流开关只由本地判定，不再读取官方 client config/rollout。
 *
 * 历史实现会请求官方 `/api/v1/client/configs` 并缓存灰度模式；该接口属于官方对客户端的
 * 远端控制面，本仓审计边界要求切断。现在的优先级只有两级：
 * 1. `ZCODE_DYNAMIC_WORKFLOW_MODE` 显式覆盖（source=override）；
 * 2. 未设置时默认 disabled（source=default）。
 *
 * `forceRefresh` 仅为保持 RPC 接口兼容而保留，本地判定没有缓存需要失效。
 */
export function createCodingPlanSubscriptionService(): ICodingPlanSubscriptionService {
  return {
    async getDynamicWorkflowClientConfig(): Promise<DynamicWorkflowClientConfig> {
      return resolveDynamicWorkflowClientConfig({ remote: undefined, env: process.env });
    },
  };
}
