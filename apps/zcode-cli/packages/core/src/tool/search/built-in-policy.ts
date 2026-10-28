import type { ToolEntry } from "../types.js";

// 官方3.16.2的延迟叶子策略集中在注册边界；不改目标权限、schema或handler。
const DEFERRED_BUILT_IN_NAMES: ReadonlySet<string> = new Set([
  "Agent",
  "Task",
  "WebFetch",
  "WebSearch",
  "TodoRead",
  "TodoWrite",
  "CronCreate",
  "CronList",
  "CronUpdate",
  "CronDelete",
  "EnterPlanMode",
  "ExitPlanMode",
  "SendMessage",
  "RespondToCoordinator",
  "submit_result",
  "escalate",
  "TaskOutput",
  "TaskStop",
  "ReadSessionContext",
  "js",
  "CreateWorkflow",
  "AmendWorkflow",
  "FillWorkflowHole",
  "SaveWorkflow",
  "ListSavedWorkflows",
  "ListModels",
  "EvalWorkflowSnippet",
  "ListWorkflowRuns",
  "GetWorkflowRun",
  "ResumeWorkflowRun",
  "ResolveWorkflowQuestion",
]);
export function withBuiltInToolSearchMetadata(entry: ToolEntry): ToolEntry {
  return DEFERRED_BUILT_IN_NAMES.has(entry.metadata.name)
    ? { ...entry, metadata: { ...entry.metadata, shouldDefer: true } }
    : entry;
}
