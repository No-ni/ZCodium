/**
 * desktop-source-connection 标准调用示例：只读取已在线物理连接的只读 scope。
 * 离线、busy、manager 关闭与换代一律拒绝；示例不创建任何新连接。
 */
import type { SourceServerConnectionManager } from "./contract.js";

/** 设备设置端口按连接 generation 隔离；离线时抛错，不回退到新连接。 */
export function readSourceSettingsScope(
  manager: SourceServerConnectionManager,
  sourceServerId: string,
) {
  return manager.getSettingsScope(sourceServerId);
}

/** Bot 与设置共用同一只读 scope；owner 未换代才继续发命令。 */
export function readOnlineSourceScope(
  manager: SourceServerConnectionManager,
  sourceServerId: string,
) {
  return manager.getOnlineSource(sourceServerId);
}
