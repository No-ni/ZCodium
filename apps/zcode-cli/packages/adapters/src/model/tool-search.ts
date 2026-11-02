import { TOOL_SEARCH_BETA, type Model, type ToolSearchCapability } from "@zcode/contracts";

export function resolveToolSearchCapability(apiType: string): ToolSearchCapability {
  // SDK已验证支持Anthropic Messages wire；不从账号/套餐或供应商名称推断启用资格。
  // Auto默认走Local，用户显式Native才开启这条实验wire。
  return Object.freeze({
    protocolSupported: apiType === "anthropic-messages",
    defaultEnabled: false,
  });
}
export function toolSearchHeaders(
  headers: Record<string, string> | undefined,
  enabled?: boolean,
): Record<string, string> | undefined {
  if (!enabled) return headers;
  const result = { ...headers };
  const key =
    Object.keys(result).find((name) => name.toLowerCase() === "anthropic-beta") ?? "anthropic-beta";
  result[key] = [
    ...new Set([
      ...(result[key]
        ?.split(",")
        .map((value) => value.trim())
        .filter(Boolean) ?? []),
      TOOL_SEARCH_BETA,
    ]),
  ].join(",");
  return result;
}

/** 模型请求能力按协议判断，不借官方账号或套餐打开能力。 */
export function resolveModelRequestCapabilities(
  apiType: string,
): NonNullable<Model["requestCapabilities"]> {
  return {
    toolSearch: resolveToolSearchCapability(apiType),
    // 只在 Anthropic Messages 协议把提醒并入 tool result；OpenAI 兼容协议保持独立的 user 消息。
    foldRemindersIntoToolResults: apiType === "anthropic-messages",
  };
}
