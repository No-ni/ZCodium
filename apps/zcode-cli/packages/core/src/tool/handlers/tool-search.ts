import {
  TOOL_SEARCH_NAME,
  ToolSearchInputJsonSchema,
  ToolSearchInputSchema,
  ToolSearchOutputJsonSchema,
  ToolSearchOutputSchema,
} from "@zcode/contracts";
import type { ToolEntry } from "../types.js";
import { NATIVE_TOOL_SEARCH_DESCRIPTION } from "../search/description.js";
import { searchTools } from "../search/search.js";

const MAX_SEARCH_RESULT_BYTES = 100_000;
const SEARCH_TIMEOUT_MS = 10_000;
export const toolSearchToolEntry: ToolEntry = {
  capability: "Search current available tools and load their definitions",
  metadata: {
    name: TOOL_SEARCH_NAME,
    description: NATIVE_TOOL_SEARCH_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    alwaysLoad: true,
    timeoutMs: SEARCH_TIMEOUT_MS,
    maxOutputBytes: MAX_SEARCH_RESULT_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  inputSchema: ToolSearchInputJsonSchema,
  outputSchema: ToolSearchOutputJsonSchema,
  runtimeInputSchema: ToolSearchInputSchema,
  runtimeOutputSchema: ToolSearchOutputSchema,
  handler: async (input, context) => {
    context.abortSignal.throwIfAborted();
    if (!context.toolSearch?.enabled)
      throw new Error("ToolSearch is not enabled for this request.");
    const { query, max_results } = ToolSearchInputSchema.parse(input);
    // 仅返回本次请求完整可用目录里的名称，不调用目标、不修改权限或发现 Set。
    const catalog = context.toolSearch.catalog;
    return {
      query,
      matches: searchTools(query, catalog, max_results),
      total_deferred_tools: catalog.filter((tool) => tool.deferred).length,
    };
  },
  formatModelContent: (output) => {
    const { matches } = ToolSearchOutputSchema.parse(output);
    return matches.length
      ? matches.map((toolName) => ({ type: "tool_reference" as const, toolName }))
      : "No matching deferred tools found";
  },
  permission: {
    permission: "tool.search",
    reason: "Search the current allowed tool catalog",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_SEARCH_RESULT_BYTES,
    maxModelBytes: MAX_SEARCH_RESULT_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_SEARCH_RESULT_BYTES, direction: "head" },
  },
  timeout: { defaultMs: SEARCH_TIMEOUT_MS, maxMs: SEARCH_TIMEOUT_MS, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "ToolSearch was cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
