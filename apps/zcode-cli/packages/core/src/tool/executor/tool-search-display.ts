import {
  TOOL_SEARCH_DISPLAY_MAX_MATCHES,
  TOOL_SEARCH_DISPLAY_MAX_NAME_BYTES,
  TOOL_SEARCH_DISPLAY_MAX_QUERY_BYTES,
  TOOL_SEARCH_NAME,
  ToolSearchOutputSchema,
  type ToolSearchToolResultDisplayPayload,
} from "@zcode/contracts";
import { boundDisplayText } from "./display-text.js";

export function createToolSearchDisplay(
  toolName: string,
  output: unknown,
): ToolSearchToolResultDisplayPayload | undefined {
  if (toolName !== TOOL_SEARCH_NAME) return undefined;
  const parsed = ToolSearchOutputSchema.safeParse(output);
  if (!parsed.success) return undefined;
  const { query, matches, total_deferred_tools } = parsed.data;
  const boundedQuery = boundDisplayText(query, TOOL_SEARCH_DISPLAY_MAX_QUERY_BYTES);
  const boundedNames = matches
    .slice(0, TOOL_SEARCH_DISPLAY_MAX_MATCHES)
    .map((name) => boundDisplayText(name, TOOL_SEARCH_DISPLAY_MAX_NAME_BYTES));
  // 展示不走 provider resultBudget；只限卡片副本，完整引用与 Local schema/发现事实保持原样。
  const truncated =
    boundedQuery.truncated ||
    matches.length > boundedNames.length ||
    boundedNames.some((name) => name.truncated);
  return {
    kind: "tool_search",
    query: boundedQuery.value,
    matches: boundedNames.map((name) => name.value),
    totalMatches: matches.length,
    totalDeferredTools: total_deferred_tools,
    ...(truncated ? { truncated: true } : {}),
  };
}
