import type { IServiceAccessor } from "@zcode/services";
import {
  getRemoteWorkspaceServicesForIdentity,
  getRemoteWorkspaceSession,
} from "@/store/remoteWorkspaceSessionStore.js";

export function resolveTaskExecutionWorkspaceServices(params: {
  baseServices: IServiceAccessor;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}): IServiceAccessor | null {
  // 侧栏包含多个工作区，不能借用当前 Host；目标远程断连时也不能回退本机。
  const remoteSessionId = params.remoteSessionId?.trim();
  if (remoteSessionId) {
    return getRemoteWorkspaceSession(remoteSessionId)?.services ?? null;
  }

  const workspaceIdentity = params.workspaceIdentity?.trim();
  if (workspaceIdentity) {
    return getRemoteWorkspaceServicesForIdentity(workspaceIdentity);
  }

  return params.baseServices;
}
