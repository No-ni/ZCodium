import {
  CoreErrorType,
  createCoreError,
  DEFERRED_TOOL_CALL_NAME,
  DeferredToolCallInputSchema,
  TOOL_SEARCH_NAME,
  type ToolSearchExecutionContext,
} from "@zcode/contracts";
import type { ToolRegistry } from "./registry.js";
import type { ExecutableToolCall } from "./types.js";

// 调度、stream admission与executor共用解析；失败不进入目标Hook/权限生命周期。
export function resolveDeferredToolCall<T extends ExecutableToolCall>(
  call: T,
  search: ToolSearchExecutionContext | undefined,
  registry: Pick<ToolRegistry, "get">,
): { call: T; error?: Error } {
  if (call.name !== DEFERRED_TOOL_CALL_NAME) return { call };
  const reject = (message: string) => ({
    call,
    error: createCoreError(CoreErrorType.ToolExecutionFailed, message, { recoverable: true }),
  });
  if (
    !search?.enabled ||
    search.mode !== "local" ||
    !search.catalog.some((tool) => tool.name === DEFERRED_TOOL_CALL_NAME)
  )
    return reject("DeferredToolCall is not available for this request.");
  const parsed = DeferredToolCallInputSchema.safeParse(call.input);
  if (!parsed.success) return reject("Invalid DeferredToolCall input.");
  const { name, input } = parsed.data;
  const candidate = search.catalog.find((tool) => tool.name === name);
  const entry = registry.get(name);
  if (!candidate || !entry) return reject(`Tool not available in this request: ${name}`);
  if (
    name === TOOL_SEARCH_NAME ||
    name === DEFERRED_TOOL_CALL_NAME ||
    entry.providerNative ||
    !candidate.deferred
  )
    return reject(`Call ${name} directly; DeferredToolCall only accepts deferred tools.`);
  // 不检查 discovered：发现不是授权。目标完整schema/Hook/权限仍在原executor校验。
  return { call: { ...call, name, input, modelCallWrapper: DEFERRED_TOOL_CALL_NAME } };
}
