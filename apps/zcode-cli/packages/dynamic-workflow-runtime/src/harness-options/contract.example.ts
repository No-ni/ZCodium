/**
 * cli-workflow-harness-options 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { RunSettlement } from "@zcode/dynamic-workflow";
import type { RunWorkflowOptions } from "./contract.js";

export function exampleCliWorkflowHarnessOptions(
  run: (options: RunWorkflowOptions) => Promise<RunSettlement>,
  options: RunWorkflowOptions,
): Promise<RunSettlement> {
  return run(options);
}
