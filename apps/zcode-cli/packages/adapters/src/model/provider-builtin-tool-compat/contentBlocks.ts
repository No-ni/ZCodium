// Provider 内置工具（GLM 的 analyze_image / webReader 等）的 Anthropic 线协议兼容。
//
// 服务端执行内置工具后，把多轮结果合成一个 assistant message 下发：
//   text(「**🌐 …」markdown) → server_tool_use(未知名) → text(「**Output:** …」markdown) → 裸 tool_result → 下一轮
// AI SDK 只认识固定名单的 server_tool_use，也不接受裸 tool_result，两者都会被丢弃，
// 只剩 markdown 进入正文和下一次请求，模型会照着文字假装调用工具。
// 这里把它们改写成 AI SDK 原生支持的 mcp_tool_use / mcp_tool_result（provider 执行、dynamic），
// 并去掉与结构化块重复的 markdown 渲染；没有配对上的裸 tool_result 仍交给上层丢弃。
//
// 服务端新格式直接下发 SDK 原生块，结果摘要挪到结果之后：
//   text(「**🌐 …」) → mcp_tool_use → mcp_tool_result → text(「**Output:** …」) → 下一轮
// 原生块原样透传，只去掉两段 markdown 渲染。全量切换前两种格式都会出现。
// 服务端不一定遵守协议：原生调用缺 server_name 时补上，没有配对调用的 mcp_tool_result 丢弃，
// 两者都会让 AI SDK 整轮失败（见 docs/design/v2/model/anthropic-stream-compat.md）。

/**
 * 旧格式改写和补齐上游缺失时用的 server_name。AI SDK schema 要求它是字符串；
 * 下游不依赖它的值（卡片用 core 的 provider-tool-rounds/cards.ts 里的常量）。
 */
export const PROVIDER_BUILTIN_TOOL_SERVER_NAME = "zcode-provider-builtin";

// @ai-sdk/anthropic 3.0.81 自己能解析的 server_tool_use 名称，保持原样。
const SDK_KNOWN_SERVER_TOOL_NAMES = new Set([
  "web_fetch",
  "web_search",
  "code_execution",
  "text_editor_code_execution",
  "bash_code_execution",
  "tool_search_tool_regex",
  "tool_search_tool_bm25",
  "advisor",
]);

// 服务端渲染副本的前缀，按缓冲角色取。不写厂商名。
// 调用头以「**🌐」开头；旧格式结果以加粗标签开头；新格式结果摘要以「**Output:**」开头，
// 整块收完后还要用配对调用的摘要标签确认身份（isRenderedSummary）。
const RENDERING_PREFIX = { call: "**🌐", result: "**", summary: "**Output:**" } as const;

export function isProviderBuiltinServerToolUse(
  block: Record<string, unknown> | undefined,
): boolean {
  return (
    block?.type === "server_tool_use" &&
    typeof block.id === "string" &&
    typeof block.name === "string" &&
    !SDK_KNOWN_SERVER_TOOL_NAMES.has(block.name)
  );
}

function isUpstreamMcpToolUse(block: Record<string, unknown> | undefined): boolean {
  return block?.type === "mcp_tool_use" && typeof block.id === "string";
}

/**
 * 上游新格式的调用块只补 AI SDK schema 必需的 server_name，已有时原样返回同一个对象。
 * 修复原因：2026-11-05 线上漏发这个字段，SDK 校验失败让整轮报错，图片留在历史里后每轮都失败。
 */
function withServerName(block: Record<string, unknown>): Record<string, unknown> {
  return typeof block.server_name === "string"
    ? block
    : { ...block, server_name: PROVIDER_BUILTIN_TOOL_SERVER_NAME };
}

/**
 * 新格式结果摘要的身份：「**Output:**」后面紧跟配对调用的「**<工具名>_result_summary:**」，
 * 例如「**Output:**\n**analyze_image_result_summary:** …」。
 * 修复原因（评审 CR-01）：摘要后面没有结构块可确认，模型下一轮的正文也会紧跟结果出现；
 * 只看前缀时，以 **Output:** 开头的模型回答会被整块删掉。旧格式靠后面的配对 tool_result 确认，
 * 新格式只能靠摘要自带的工具名标签；标签对不上只会漏删，不会误删。
 */
function isRenderedSummary(text: string, toolName: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith(RENDERING_PREFIX.summary) &&
    trimmed
      .slice(RENDERING_PREFIX.summary.length)
      .trimStart()
      .startsWith(`**${toolName}_result_summary:**`)
  );
}

export function toMcpToolUseBlock(block: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "mcp_tool_use",
    id: block.id,
    name: block.name,
    input: block.input ?? {},
    server_name: PROVIDER_BUILTIN_TOOL_SERVER_NAME,
  };
}

export function toMcpToolResultBlock(block: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "mcp_tool_result",
    tool_use_id: block.tool_use_id,
    is_error: block.is_error === true,
    content: toMcpResultContent(block.content),
  };
}

function toMcpResultContent(content: unknown): Array<{ type: "text"; text: string }> {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) {
    return content.map((item) => {
      const record = asRecord(item);
      if (record?.type === "text" && typeof record.text === "string") {
        return { type: "text", text: record.text };
      }
      return { type: "text", text: typeof item === "string" ? item : JSON.stringify(item) };
    });
  }
  return [{ type: "text", text: content === undefined ? "" : JSON.stringify(content) }];
}

function isRenderingText(block: Record<string, unknown> | undefined, prefix: string): boolean {
  return (
    block?.type === "text" &&
    typeof block.text === "string" &&
    block.text.trimStart().startsWith(prefix)
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
export {
  SDK_KNOWN_SERVER_TOOL_NAMES,
  RENDERING_PREFIX,
  isUpstreamMcpToolUse,
  withServerName,
  isRenderedSummary,
  toMcpResultContent,
  isRenderingText,
  asRecord,
};
