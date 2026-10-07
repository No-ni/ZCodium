import { IZCodeTaskService, type ServiceCollection } from "@zcode/services";
import type { ResolveTaskAutoArchiveRemoteTarget } from "@zcode/services/node";
import type { WindowHostAttachmentScope } from "@zcode/shared";

interface Registry {
  findSessionForWorkspace(scope: { workspacePath: string; workspaceIdentity?: string }): {
    workspacePath?: string;
    workspaceIdentity?: string;
    remoteSessionId: string;
    sourceAvailability: "online" | "offline";
  } | null;
  resolveScopedServices(scope: WindowHostAttachmentScope): ServiceCollection;
}

export function createTaskAutoArchiveRemoteTargetResolver(
  registry: Registry,
): ResolveTaskAutoArchiveRemoteTarget {
  return (workspace) => {
    const session = registry.findSessionForWorkspace(workspace);
    if (
      !session ||
      session.sourceAvailability !== "online" ||
      session.workspacePath !== workspace.workspacePath ||
      session.workspaceIdentity !== workspace.workspaceIdentity
    )
      return undefined;
    const scope = {
      kind: "remote" as const,
      ...workspace,
      remoteSessionId: session.remoteSessionId,
    };
    return {
      ...workspace,
      remoteSessionId: scope.remoteSessionId,
      archiveStaleTasks: (params) => {
        // 提交时再解析完整 scope，连接换代/离线不能复用之前解析到的 facade 或回退本地。
        return registry
          .resolveScopedServices(scope)
          .get(IZCodeTaskService)
          .archiveStaleTasks({
            ...params,
            ...workspace,
            remoteSessionId: scope.remoteSessionId,
          });
      },
    };
  };
}
