import type { McpNodeFallback, McpNodeFallbackProvider } from "./contract.js";

/** provider 生命周期内 resolve 复用同一准备 flight；不可用由调用方沿既有 MCP 启动路径处理。 */
export async function readPreparedFallbackExample(provider: McpNodeFallbackProvider): Promise<McpNodeFallback | undefined> {
  const fallback = await provider.resolve();
  if (!fallback) return undefined;
  return { binDir: fallback.binDir, env: { ...fallback.env } };
}
