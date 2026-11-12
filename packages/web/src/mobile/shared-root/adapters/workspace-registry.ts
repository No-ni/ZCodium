import {
  bindRemoteWorkspaceIdentity,
  bindRemoteWorkspacePath,
  getRegisteredBaseWorkspaceServices,
  getRemoteWorkspaceSession,
  registerBaseWorkspaceServices,
  registerRemoteWorkspaceSession,
  unregisterRemoteWorkspaceSession,
} from "@zcode/ui/remote-workspace-session-store";
import type { MobileRootWorkspaceAccess } from "../contract.js";

/** 借用已有 registry；配对协议仍是 transport disposer 的唯一所有者。 */
export function registerMobileRootWorkspace(access: MobileRootWorkspaceAccess): () => void {
  if (!access.isCurrent()) throw new Error("mobile-workspace-superseded");
  const { services, descriptor } = access;
  const remoteSessionId = descriptor.remoteSessionId;
  if (descriptor.kind === "remote") {
    if (!remoteSessionId || !descriptor.workspaceIdentity?.trim())
      throw new Error("mobile-workspace-scope-unavailable");
    // 中文修复依据：Root 首次 render 先查共享 registry，不能等其 effect 才替换旧代代理。
    // 不给 borrowed session 安装协议 disposer；换代/卸载仅撤登记，不能关闭新桥或桌面 Host。
    registerRemoteWorkspaceSession({
      sessionId: remoteSessionId,
      workspacePath: descriptor.workspacePath,
      workspaceIdentity: descriptor.workspaceIdentity,
      services,
    });
    bindRemoteWorkspacePath(descriptor.workspacePath, remoteSessionId);
    bindRemoteWorkspaceIdentity(descriptor.workspaceIdentity, remoteSessionId);
  }
  registerBaseWorkspaceServices(services);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    // 旧 Root 的迟到清理不能撤销同 sessionId 的新 accessor 或新 base。
    if (remoteSessionId && getRemoteWorkspaceSession(remoteSessionId)?.services === services)
      unregisterRemoteWorkspaceSession(remoteSessionId);
    if (getRegisteredBaseWorkspaceServices() === services) registerBaseWorkspaceServices(null);
  };
}
