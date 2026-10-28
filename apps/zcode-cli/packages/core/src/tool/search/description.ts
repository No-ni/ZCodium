function description(local: boolean): string {
  return `Load complete JSONSchema definitions for deferred tools.\n\nDeferred tool names appear in system reminders. Search does not execute or authorize a tool; normal hooks and permissions still apply. ${local ? "Call deferred tools with DeferredToolCall {name, input}; call resident tools directly." : "After loading a definition, call that tool directly."}\n\nQuery forms:\n- "select:Read,Edit,Grep" selects exact names or aliases.\n- "notebook jupyter" ranks keyword matches up to max_results.\n- "+fixture lookup" requires fixture and ranks the remaining terms.\n\nLocal results contain <functions> with one <function>{"description":"...","name":"...","parameters":{...}}</function> per complete schema. Native results carry provider tool references.`;
}
export const NATIVE_TOOL_SEARCH_DESCRIPTION = description(false);
export const LOCAL_TOOL_SEARCH_DESCRIPTION = description(true);
