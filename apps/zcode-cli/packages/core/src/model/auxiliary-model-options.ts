import type { Model, ModelOptions } from "@zcode/contracts";

const AUXILIARY_MAX_OUTPUT_TOKENS = 5_000;

/**
 * 辅助调用缺省使用公开档位的最低项；总结偏好可显式指定档位，输出预算保持不变。
 * 档位顺序来自 Model Config，
 * 不能再按 disabled/off 等名字推断协议行为。
 */
export function auxiliaryModelOptions(
  model: Model,
  reasoningLevel?: string,
): Required<ModelOptions> {
  return {
    reasoningLevel: reasoningLevel ?? model.optionSpecs.reasoningLevel.values[0]!,
    maxOutputTokens: Math.min(AUXILIARY_MAX_OUTPUT_TOKENS, model.optionSpecs.maxOutputTokens.max),
  };
}
