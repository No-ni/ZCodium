// ============================================================
// AmendWorkflow 确认窗预览
// ============================================================
// 从 amend-workflow.ts 拆出：handler 文件越过 max-lines 上限，而确认窗预览是一段自洽的纯逻辑——
// 模型入参进，`{gate:"proceed"}` 或 `{gate:"ask", display}` 出，无 I/O、无端口、无 memo。

import { AMEND_WORKFLOW_TOOL_NAME, AmendWorkflowInputSchema } from "@zcode/contracts";
import type { ToolApprovalGate } from "../types.js";
import { displayOfAnalysis } from "./workflow-analysis-display.js";
import { analyzeScript } from "./workflow-script-analysis.js";
import { allScriptModelsBound, readScriptModelBindings } from "./workflow-script-models.js";

/**
 * 确认窗预览：与 CreateWorkflow 同一段代码（编不过即放行给 handler 回诊断）。display 的 kind
 * 仍是 `create_workflow`——图、草稿笔与诊断卡在 UI 侧只有一份实现；「这是修订」由工具名与入参
 * 的 `run_id` / `predecessor` 说出来。
 */
export function prepareAmendWorkflowApproval(input: unknown): ToolApprovalGate {
  const parsed = AmendWorkflowInputSchema.safeParse(input);
  // 没有脚本就没有可批的东西，两种情形共用这一条放行：
  //   - 就地调并发：窗的用处是
  //     把将要跑的脚本摆到人面前，而这条路一段脚本都不跑，只把一个数挪进 `[1, 天花板]`；
  //     **归属无关**——别人的 run 也不弹窗，否则一次「什么都没批」会被当成批准了一次新 run。
  //   - 有人绕过了归一化：放行给 handler，它回结构化失败，窗开了也无物可批。
  if (!parsed.success || parsed.data.script === undefined) return { gate: "proceed" };
  const analysis = analyzeScript(parsed.data.script);
  if (!analysis.ok) return { gate: "proceed" };
  // 有没绑定的模型名：同 CreateWorkflow，不开窗，让 handler 报 9011。
  if (!allScriptModelsBound(analysis, readScriptModelBindings(parsed.data))) {
    return { gate: "proceed" };
  }
  const display = displayOfAnalysis(analysis, AMEND_WORKFLOW_TOOL_NAME);
  return { gate: "ask", ...(display ? { display } : {}) };
}
