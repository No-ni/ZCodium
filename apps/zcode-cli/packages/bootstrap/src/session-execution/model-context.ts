import { modelExecutionSchema } from "@zcode/shared";
import type { ModelExecutionInput, ModelExecutionContext } from "./contract.js";

/** 两种输入协议共用严格的普通单轮约束，禁止把退休票据接回请求依赖。 */
export function createModelExecutionContext(input: ModelExecutionInput): ModelExecutionContext {
  // 入口也校验真实材料；内部直调不能用多余字段绕过协议的 strict 边界。
  const material = modelExecutionSchema.parse(input);
  return {
    ...(material.memoryExtraction ? { memoryExtraction: material.memoryExtraction } : {}),
    selectionScope: "execution",
    ...(material.subagents ? { subagents: material.subagents } : {}),
  };
}
