import { safeLogArgs } from "@zcode/shared";
import { MessagePortProtocol, ChannelClient } from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import { RemoteServiceAccess } from "./remoteServiceAccess.js";
import { isRendererProductionBuild } from "./rendererLoggingEnv.js";

function logMessagePortDebug(message: string): void {
  // 生产构建下 renderer 连接日志不输出，避免窗口启动和重连路径产生同步 console 成本。
  if (isRendererProductionBuild()) {
    return;
  }
  console.log(...safeLogArgs([message]));
}

export interface MessagePortServiceConnection {
  services: IServiceAccessor;
  dispose: (reason?: Error) => void;
}

// 修复依据：两个入口曾各自声明重名的 options 形参，合并后统一由一份选项描述装配开关，
// 避免 connectViaMessagePort 转发时按不同的字段集合丢选项。默认全部关闭。
interface MessagePortServiceOptions {
  sourceServerManagementService?: boolean;
  windowProjectDirectory?: boolean;
  deviceSyncStateService?: boolean;
}

/**
 * 创建一个带明确生命周期的 MessagePort service connection。
 *
 * scoped remote session 换代时必须同时释放 ChannelClient 和底层 port，
 * 否则旧 attachment 上的挂起 RPC 无法 settle，并会继续占用上层去重状态。
 */
export function createMessagePortServiceConnection(
  port: MessagePort,
  options: MessagePortServiceOptions = {},
): MessagePortServiceConnection {
  logMessagePortDebug("[messageport] creating protocol and client...");
  const protocol = new MessagePortProtocol(port);
  const client = new ChannelClient(protocol);
  client.onDidInitialize(() => {
    logMessagePortDebug("[messageport] ChannelClient received Initialize from server");
  });
  logMessagePortDebug("[messageport] client created, waiting for Initialize...");

  const services = new RemoteServiceAccess(client, options);
  let disposed = false;
  return {
    services,
    dispose: (reason?: Error) => {
      if (disposed) {
        return;
      }
      disposed = true;
      client.dispose(reason);
      protocol.disconnect();
    },
  };
}

/**
 * 通过 MessagePort 连接服务。
 *
 * Desktop 模式下，utilityProcess（或 main 进程的远程代理）通过 MessagePort
 * 暴露 ChannelServer，renderer 用此函数建立 ChannelClient 连接。
 */
export function connectViaMessagePort(
  port: MessagePort,
  options: MessagePortServiceOptions = {},
): IServiceAccessor {
  return createMessagePortServiceConnection(port, options).services;
}
