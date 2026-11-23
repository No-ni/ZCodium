import type { Logger } from "@zcode/contracts";

export interface McpNodeFallback {
  /** 追加到 stdio MCP 子进程 PATH 末尾的 shim 目录。 */
  binDir: string;
  /** shim 需要的环境变量（Electron 可执行文件与可选的随包 npm 根目录）。 */
  env: Record<string, string>;
}

export interface McpNodeFallbackProvider {
  /** 首次调用时准备 shim 目录；结果（含失败）在 provider 生命周期内复用。失败时返回 undefined。 */
  resolve(): Promise<McpNodeFallback | undefined>;
}

export interface CreateMcpNodeFallbackProviderOptions {
  /** Electron 可执行文件（agent 的 process.execPath）。 */
  execPath: string;
  logger?: Logger;
  /** 随包 npm 根目录候选，按顺序取第一个完整的。 */
  npmRootCandidates: readonly string[];
  platform?: NodeJS.Platform;
  /** shim 目录落在 `<storageRoot>/node-fallback/<layout>`。 */
  storageRoot: string;
}

export interface NodeFallbackShimFile {
  content: string;
  executable: boolean;
  name: string;
}

