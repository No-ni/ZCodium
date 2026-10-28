import { DEFERRED_TOOL_CALL_NAME, type ModelToolContract } from "@zcode/contracts";
import { wrapSystemReminderForSource } from "../../system-reminder/source.js";

// 编码缓存只活在本次请求，下一次请求重读当前 schema，不能留下过期定义。
export function createLocalToolDefinitionRenderer(): (tool: ModelToolContract) => string {
  const definitions = new Map<ModelToolContract, string>();
  return (tool) => {
    let definition = definitions.get(tool);
    if (definition === undefined) {
      definition = `<function>${JSON.stringify({ description: tool.description ?? "", name: tool.name, parameters: tool.inputSchema })}</function>`;
      definitions.set(tool, definition);
    }
    return definition;
  };
}
export function localToolsLoadedReminder(names: readonly string[]): string {
  return wrapSystemReminderForSource(
    "tool_result_warning",
    `Loaded: ${names.join(", ")}. Call these deferred tools with ${DEFERRED_TOOL_CALL_NAME} {"name":"<tool name>","input":{...}}, using the complete schema above. Discovery is not permission; normal hooks and approvals still apply.`,
  );
}
export function localToolsAlreadyLoadedReminder(names: readonly string[]): string {
  return wrapSystemReminderForSource(
    "tool_result_warning",
    `Tool definitions already available in this conversation: ${names.join(", ")}. Call them with ${DEFERRED_TOOL_CALL_NAME} {name, input}. Searching again does not execute or authorize them.`,
  );
}
