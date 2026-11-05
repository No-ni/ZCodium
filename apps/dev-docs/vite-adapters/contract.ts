import type { Plugin } from "vite";
/** 工厂只安装插件；真实文件读取仅在Vite请求/构建回调中进行。 */
export interface DevDocsVitePlugins {
  stdioTrafficApiPlugin(): Plugin;
  featureBoundaryGraphPlugin(): Plugin;
}
export interface StdioTrafficReadResponse {
  status: "ready" | "empty" | "missing" | "error";
  logDir: string;
  records: Array<{ index: number; record: unknown }>;
  workspaceHash?: string;
  filePath?: string;
  updatedAt?: string;
  error?: string;
}
