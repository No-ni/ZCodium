/**
 * desktop-source-connection 对外契约。
 *
 * 这里只重新导出当前已经存在的公开端口，不新增 API、不写实现：物理连接 owner、
 * Source 目录与 Bot 适配仍由同模块的 sourceServerConnectionManager.ts、
 * sourceServerDirectory.ts、botProjectBridge.ts 提供。不变量见 CONTRACT.md。
 */
export type {
  ManagedSourceHandle,
  ManagerOptions,
  OnlineSource,
} from "../sourceServerConnectionTypes.js";
export type {
  SourceServerDirectory,
  SourceServerDirectoryError,
} from "../sourceServerDirectory.js";
export type { SourceServerRpcConnection } from "../sourceServerRpc.js";
export type { SourceServerConnectionManager } from "../sourceServerConnectionManager.js";
