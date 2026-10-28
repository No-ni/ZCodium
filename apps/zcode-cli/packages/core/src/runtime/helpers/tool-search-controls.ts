import { TOOL_SEARCH_NAME, DEFERRED_TOOL_CALL_NAME } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import { toolSearchToolEntry } from "../../tool/handlers/tool-search.js";
import { deferredToolCallEntry } from "../../tool/handlers/deferred-tool-call.js";
import { isToolNameDisallowed } from "../../tool/tool-visibility.js";
import { resolveBuiltInToolAllowlist, resolveRuntimeDisallowedTools } from "./tool-allowlist.js";

export function refreshRuntimeToolSearchControls(
  runtime: Pick<AgentRuntimeInternal, "config" | "registry" | "cachedTools" | "activeTurn">,
  options: { preserveActiveRequest?: boolean } = {},
): void {
  const allowlist = resolveBuiltInToolAllowlist(runtime.config);
  const disallowed = resolveRuntimeDisallowedTools(runtime.config);
  const enabled =
    runtime.config.toolSearch?.mode !== undefined && runtime.config.toolSearch.mode !== "off";
  for (const entry of [toolSearchToolEntry, deferredToolCallEntry]) {
    const name = entry.metadata.name;
    if (
      !enabled ||
      (allowlist && !allowlist.includes(name)) ||
      isToolNameDisallowed(name, disallowed)
    ) {
      // 已发请求只读旧快照；下一 round 或回合关闭再统一收敛注册表，不新增配置/发现 owner。
      if (!(options.preserveActiveRequest && runtime.activeTurn)) runtime.registry.unregister(name);
    } else if (!runtime.registry.has(name)) {
      runtime.registry.register(entry);
    }
  }
  runtime.cachedTools = null;
}
export function isToolSearchControlName(name: string): boolean {
  return name === TOOL_SEARCH_NAME || name === DEFERRED_TOOL_CALL_NAME;
}
