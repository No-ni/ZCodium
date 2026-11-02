import type { Event } from "@zcode/rpc";
import {
  ServiceChannels,
  type ConnectionProfile,
  type SourceServerIdentityConfirmation,
  type SourceServerManagementSnapshot,
  type SourceServerProfileOperation,
  type SourceServerRunningTasksResult,
} from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ISourceServerManagementService {
  getCapabilities(): Promise<{ version: 1 }>;
  onDidChange: Event<void>;
  getSnapshot(): Promise<SourceServerManagementSnapshot>;
  saveProfile(profile: ConnectionProfile): Promise<SourceServerManagementSnapshot>;
  removeProfile(input: SourceServerProfileOperation): Promise<SourceServerManagementSnapshot>;
  connectProfile(input: SourceServerProfileOperation): Promise<SourceServerManagementSnapshot>;
  confirmIdentityChange(
    input: SourceServerIdentityConfirmation,
  ): Promise<SourceServerManagementSnapshot>;
  disconnectSource(input: { sourceServerId: string }): Promise<SourceServerManagementSnapshot>;
  /**
   * 显式停止远端预部署服务（RDLC-01）：Host 先断开并删除恢复意图，再在远端执行 `stop --wait`。
   * 只做停止，不部署、不下载、不注册、不升级；成功和失败后设备都保持未连接，失败抛带 code 的错误。
   */
  stopSource(sourceServerId: string): Promise<SourceServerManagementSnapshot>;
  /**
   * 显式重启远端预部署服务（RDLC-01）：登记生命周期 flight（期间显示连接中），在远端执行
   * `restart`，成功后走现有连接流程并发出重连。不触发任何自动部署或更新下载。
   */
  restartSource(sourceServerId: string): Promise<SourceServerManagementSnapshot>;
  /**
   * 停止 / 重启确认前读取远端运行中任务。设备未提供可信清单时返回 `{ available: false }`，
   * 不当作没有任务；凭据不可静默取得时抛 `credentials-required`。只对桌面 Renderer 开放。
   */
  getSourceRunningTasks(sourceServerId: string): Promise<SourceServerRunningTasksResult>;
}

export const ISourceServerManagementService =
  createServiceDescriptor<ISourceServerManagementService>(ServiceChannels.SourceServerManagement);
