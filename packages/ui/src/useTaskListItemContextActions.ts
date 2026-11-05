import type { ZCodeProvider } from "@zcode/shared";
import { useCallback } from "react";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useTaskNativeSessionLogFile } from "@/hooks/useTaskNativeSessionLogFile.js";
import { useTaskSessionFilePath } from "@/hooks/useTaskSessionFilePath.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useWorkspaceOpenInEditorTarget } from "@/hooks/useWorkspaceOpenInEditorTarget.js";
import { toast } from "@/components/ui/toast.js";
import { useBuiltinProviderConfigFile } from "@/hooks/useBuiltinProviderConfigFile.js";
import { logger } from "@/logger.js";
import { resolveTaskExecutionWorkspacePath } from "@/lib/taskExecutionWorkspacePath.js";

interface TaskPathState {
  loading: boolean;
  path: string | null;
  exists: boolean;
}

interface TaskListItemContextActionsResult {
  taskSessionFile: TaskPathState;
  taskNativeSessionLogFile: TaskPathState;
  providerConfigFile: TaskPathState;
  fileManagerLabel: string;
  handleCopyText: (label: string, value: string | null) => Promise<void>;
  handleCopyWorkspacePath: (label: string) => Promise<void>;
  handleOpenTaskPathInFileManager: () => Promise<void>;
  handleOpenProviderConfig: () => Promise<void>;
}

export function useTaskListItemContextActions({
  workspacePath,
  remoteSessionId,
  workspaceIdentity,
  taskId,
  workingDirectory,
  provider,
  intl,
  loadTaskPaths = true,
  loadProviderConfig = true,
}: {
  workspacePath: string;
  remoteSessionId?: string;
  workspaceIdentity?: string;
  taskId: string;
  /** Header 已有的当前会话 cwd；避免为同一动作再查询一次。 */
  workingDirectory?: string;
  provider?: ZCodeProvider;
  intl: {
    formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
  };
  loadTaskPaths?: boolean;
  loadProviderConfig?: boolean;
}): TaskListItemContextActionsResult {
  const platform = usePlatform();
  const workspaceServices = useWorkspaceServices(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
    undefined,
    "exact",
  );
  const workspaceOpenTarget = useWorkspaceOpenInEditorTarget({
    workspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId: remoteSessionId,
  });
  const taskSessionFile = useTaskSessionFilePath(workspacePath, taskId, workspaceIdentity, {
    // task session/log 路径只用于右键菜单项；菜单未打开时不要在列表重排中批量触发 RPC。
    enabled: loadTaskPaths,
  });
  const taskNativeSessionLogFile = useTaskNativeSessionLogFile(
    workspacePath,
    taskId,
    provider ?? null,
    workspaceIdentity,
    { enabled: loadTaskPaths },
  );
  // 本 fork 配置是环境级物化副本。合并的 workspace 查询只有占位路径，
  // 不能拿它打开工作区父目录；三个菜单共用同一平台查询与打开动作。
  const providerConfigFile = useBuiltinProviderConfigFile(loadProviderConfig);

  const handleCopyText = useCallback(async (_label: string, value: string | null) => {
    if (!value) {
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      logger.info("[TaskListItem] 文本已复制");
    } catch {
      logger.warn("[TaskListItem] 复制文本失败");
    }
  }, []);

  const resolveTaskWorkspacePath = useCallback(async () => {
    if (!taskId) {
      return workingDirectory?.trim() || workspacePath;
    }

    try {
      const path = await resolveTaskExecutionWorkspacePath(workspaceServices, {
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
        sessionId: taskId,
        knownExecutionWorkspacePath: workingDirectory,
      });
      if (path) {
        return path;
      }

      logger.warn("[TaskListItem] 精确查询未找到任务会话，停止路径操作");
    } catch {
      logger.warn("[TaskListItem] 查询任务工作目录失败，停止路径操作");
    }

    toast(intl.formatMessage({ id: "appHeader.taskWorkingDirectoryUnavailable" }));
    return null;
  }, [
    intl,
    remoteSessionId,
    taskId,
    workspaceIdentity,
    workspacePath,
    workingDirectory,
    workspaceServices,
  ]);

  const handleCopyWorkspacePath = useCallback(
    async (label: string) => {
      const path = await resolveTaskWorkspacePath();
      if (path) {
        await handleCopyText(label, path);
      }
    },
    [handleCopyText, resolveTaskWorkspacePath],
  );

  const handleOpenTaskPathInFileManager = useCallback(async () => {
    const path = await resolveTaskWorkspacePath();
    if (!path) {
      return;
    }

    const hasRemoteWorkspaceScope = Boolean(
      remoteSessionId || workspaceIdentity?.trim() || workspaceOpenTarget.isRemoteWorkspace,
    );
    if (hasRemoteWorkspaceScope) {
      if (workspaceOpenTarget.remoteTarget?.kind !== "wsl") {
        // 远程项目路径不是宿主机路径。无法精确解析为 WSL 时必须失败关闭，
        // 避免 SSH/Docker 的 Linux 路径误落到原生 Windows、macOS 或 Linux 文件管理器。
        logger.warn("[TaskListItem] 远程 workspace 不支持本机文件管理器");
        return;
      }

      const result = await platform.openInEditor("explorer", path, {
        pathKind: "directory",
        remoteTarget: workspaceOpenTarget.remoteTarget,
        workspaceIdentity,
      });
      if (!result.success) {
        logger.warn("[TaskListItem] 打开 WSL 任务工作目录失败");
      }
      return;
    }

    const isMac = isMacLike();
    const isWindows = isWindowsLike();
    if (isMac || isWindows) {
      const editorId = isMac ? "finder" : "explorer";
      const result = await platform.openInEditor(editorId, path);
      if (result.success) {
        return;
      }
    }

    const result = await platform.openInFileManager(path);
    if (!result.success) {
      // Header / task 菜单里的入口打开任务执行目录；session record 路径仍只用于“Copy task path”。
      logger.warn("[TaskListItem] 打开任务工作目录失败");
    }
  }, [
    platform,
    remoteSessionId,
    resolveTaskWorkspacePath,
    taskId,
    workspaceIdentity,
    workspaceOpenTarget.isRemoteWorkspace,
    workspaceOpenTarget.remoteTarget,
  ]);

  const handleOpenProviderConfig = useCallback(async () => {
    if (
      providerConfigFile.loading ||
      !providerConfigFile.exists ||
      !providerConfigFile.path ||
      !platform.openExternalFile
    ) {
      return;
    }

    try {
      const result = await platform.openExternalFile(providerConfigFile.path);
      if (result.success) return;
    } catch {
      // 原始平台异常可能包含真实路径，仅记录固定诊断并给用户可重试提示。
    }
    logger.warn("[TaskListItem] 打开 provider 配置失败");
    toast(intl.formatMessage({ id: "appHeader.builtinProviderConfigOpenFailed" }));
  }, [
    intl,
    platform,
    providerConfigFile.loading,
    providerConfigFile.exists,
    providerConfigFile.path,
  ]);

  return {
    taskSessionFile,
    taskNativeSessionLogFile,
    providerConfigFile,
    fileManagerLabel: getFileManagerLabel(intl),
    handleCopyText,
    handleCopyWorkspacePath,
    handleOpenTaskPathInFileManager,
    handleOpenProviderConfig,
  };
}

function isMacLike(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  return /mac/i.test(navigator.userAgent);
}

function isWindowsLike(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  return /windows/i.test(navigator.userAgent);
}

function getFileManagerLabel(intl: {
  formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
}) {
  if (isMacLike()) {
    return intl.formatMessage({ id: "appHeader.openInFinder" });
  }

  if (isWindowsLike()) {
    return intl.formatMessage({ id: "appHeader.openInFileExplorer" });
  }

  return intl.formatMessage({ id: "appHeader.openInFileManager" });
}
