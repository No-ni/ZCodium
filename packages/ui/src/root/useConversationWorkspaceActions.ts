import { useCallback } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import { logger } from "@/logger.js";
import type { TabStoreState } from "@/store/tabStore.js";

export function useConversationWorkspaceActions({
  services,
  addTab,
  createTask,
  setWorkspaceActionError,
}: {
  services: IServiceAccessor;
  addTab: TabStoreState["addTab"];
  createTask: (source: string, request?: CreateTaskRequest) => Promise<void>;
  setWorkspaceActionError: (error: string | null) => void;
}) {
  const handleSelectConversationWorkspace = useCallback(
    (path: string, workspaceIdentity?: string) => {
      // 对话工作区是 app 管理的独立 cwd，不属于用户项目：不走跨窗口项目激活，
      // 也不写 recentProjects，只用 purpose 让展示层把它归到“对话”。
      // Bug 原因：identity 在落到 tab 之前被丢掉，Shell 只能按路径反查；
      // 多设备的对话 backing path 在同 home 下同名时会命中别的设备。日志同步去掉 path。
      logger.info("[Root] select conversation workspace");
      addTab(path, {
        workspacePurpose: "conversation",
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      });
      setWorkspaceActionError(null);
    },
    [addTab, setWorkspaceActionError],
  );

  const handleResolveConversationWorkspace = useCallback(async () => {
    try {
      // 窗口 ProjectService 是该目录的唯一 owner，只从 windowProjectDirectory 取，不回落其它源。
      const projectService = services.windowProjectDirectory?.projectService;
      if (!projectService) throw new Error("project.service-unavailable");
      const target = await projectService.prepareSession();
      setWorkspaceActionError(null);
      // 契约：App 消费 { workspacePath, workspaceIdentity? }；identity 缺失时保持缺失，不伪造。
      return {
        workspacePath: target.workspacePath,
        ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[Root] ensure conversation workspace failed");
      setWorkspaceActionError(message);
      throw error;
    }
  }, [services.windowProjectDirectory?.projectService, setWorkspaceActionError]);

  const handleEnsureConversationWorkspace = useCallback(async () => {
    const { workspacePath, workspaceIdentity } = await handleResolveConversationWorkspace();
    handleSelectConversationWorkspace(workspacePath, workspaceIdentity);
    return workspacePath;
  }, [handleResolveConversationWorkspace, handleSelectConversationWorkspace]);

  const handleCreateConversationTask = useCallback(
    // 任务区入口表达明确的无项目意图，不能因当前正在查看项目而继承它。
    () => createTask("task section new task", { projectId: null }),
    [createTask],
  );

  return {
    handleSelectConversationWorkspace,
    handleResolveConversationWorkspace,
    handleEnsureConversationWorkspace,
    handleCreateConversationTask,
  };
}
