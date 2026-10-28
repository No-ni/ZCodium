import type { DynamicWorkflowClientConfig } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ICodingPlanSubscriptionService {
  /**
   * 动态工作流开关快照：只由本地 env（`ZCODE_DYNAMIC_WORKFLOW_MODE`）决定，
   * 未设置时默认 disabled（source=default）。官方 client config/rollout 已移除。
   * `forceRefresh` 仅为接口兼容保留，本地判定没有缓存需要失效。
   */
  getDynamicWorkflowClientConfig(options?: {
    forceRefresh?: boolean;
  }): Promise<DynamicWorkflowClientConfig>;
}

export const ICodingPlanSubscriptionService =
  createServiceDescriptor<ICodingPlanSubscriptionService>(ServiceChannels.CodingPlanSubscription);
