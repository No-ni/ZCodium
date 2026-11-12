import {
  createRecommendedNativeContextConfiguration,
  nativeContextConfigurationSchema,
  nativeContextPolicySchema,
  nativeContextResolvedToolProtectionSchema,
  setNativeContextParameterValue,
} from "./contract.js";
import type { NativeContextConfiguration, NativeContextPolicy } from "./contract.js";

/** 新任务默认自动压缩；编辑推荐参数只创建草稿。 */
export const defaultConfiguration: NativeContextConfiguration =
  createRecommendedNativeContextConfiguration();
export const imageDraft: NativeContextConfiguration = {
  ...defaultConfiguration,
  parameters: setNativeContextParameterValue(
    defaultConfiguration.parameters,
    "images.maxEdge",
    1200,
  ),
};
export const taskPolicy: NativeContextPolicy = nativeContextPolicySchema.parse({
  ...nativeContextConfigurationSchema.parse(imageDraft),
  policyVersion: 1,
});

/** 唯一 Runtime 返回已保存策略的匹配结果，不用 UI 草稿生成。 */
export const runtimeToolProtection = nativeContextResolvedToolProtectionSchema.parse({
  total: 1,
  items: [
    {
      name: "read",
      protected: false,
      latest: true,
      earlyFold: false,
      preserveRecent: false,
      referenceExcluded: false,
      distillExcluded: false,
    },
  ],
});
