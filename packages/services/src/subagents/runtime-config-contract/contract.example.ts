import type { SubagentRuntimeConfigEntry1 } from "./contract.js";
/** 调用方持有既有入口；示例只转交一次相同意图，不装配进程或读真实目录。 */
export function exampleSubagentRuntimeConfig(
  api: SubagentRuntimeConfigEntry1,
  ...args: Parameters<SubagentRuntimeConfigEntry1["createSubagentRuntimeConfigCache"]>
): ReturnType<SubagentRuntimeConfigEntry1["createSubagentRuntimeConfigCache"]> {
  return api.createSubagentRuntimeConfigCache(...args);
}
