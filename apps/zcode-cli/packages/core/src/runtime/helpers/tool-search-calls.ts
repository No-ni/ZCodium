import type { ModelToolCall, ToolSearchExecutionContext } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import { resolveDeferredToolCall } from "../../tool/deferred-call.js";

// 以同一解析器生成调度/持久化身份；executor还会校验未解包的失败调用。
export function resolveRuntimeModelToolCalls(
  runtime: Pick<AgentRuntimeInternal, "registry">,
  calls: readonly ModelToolCall[],
  search?: ToolSearchExecutionContext,
): ModelToolCall[] {
  return calls.map((call) => resolveDeferredToolCall(call, search, runtime.registry).call);
}
