import { ComposerSubmissionPendingContext } from "@/project-sidebar/ComposerSubmissionPendingContext.js";
import { remoteHostLabel } from "@/project-sidebar/RemoteHostSection.js";
import type { ReactNode } from "react";
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useRemoteConnectionEntryVisibility } from "@/hooks/useRemoteConnectionEntryVisibility.js";
import { cn } from "@/components/lib/utils.js";
import { logger } from "@/logger.js";
import { buildServerRemoteWorkspaceIdentity } from "@zcode/shared";

import type { ProjectSidebarProps, RemoteProjectHost } from "@/project-sidebar/contract.js";
import { remoteHostIdFromWorkspaceIdentity } from "@/project-sidebar/contract.js";
import { projectKey, projectSourceServerId } from "@/project-sidebar/view.js";
import { useProjectSelectionDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { ProjectComposerMenuDisplay } from "@/project-sidebar/ProjectComposerMenuDisplay.js";
import type { ProjectComposerMenuDisplayProps } from "@/project-sidebar/ProjectComposerMenuDisplay.types.js";

export function ProjectComposerMenu({
  workspacePath,
  workspaceIdentity,
  compactForRemoteControl = false,
  allowConversationWorkspaceSelection = true,
  allowConversationWorkspaceDetach = allowConversationWorkspaceSelection,
  onCreateTask,
  onSelectConversationWorkspace,
  allowRemoteWorkspace = true,
  onOpenRemoteWorkspace,
  containerClassName,
  triggerClassName,
  triggerIndicator,
  showEditProject = false,
  children,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  compactForRemoteControl?: boolean;
  allowConversationWorkspaceSelection?: boolean;
  /** 是否显示项目 chip 的快捷脱离按钮；默认跟随非项目工作区选择能力。 */
  allowConversationWorkspaceDetach?: boolean;
  onCreateTask: ProjectSidebarProps["onCreateTask"];
  onSelectConversationWorkspace: () => void | Promise<void>;
  allowRemoteWorkspace?: boolean;
  onOpenRemoteWorkspace?: ProjectSidebarProps["onOpenRemoteWorkspace"];
  onConnectRemote?: ProjectSidebarProps["onConnectRemote"];
  onCancelRemote?: ProjectSidebarProps["onCancelRemoteProject"];
  /** 调用方局部调整 workspace chip 外层视觉，不改变普通会话默认样式。 */
  containerClassName?: string;
  /** 调用方局部调整 workspace trigger 视觉，不改变普通会话默认样式。 */
  triggerClassName?: string;
  /** 调用方局部替换尾部 indicator；普通会话继续使用默认 Lucide chevron。 */
  triggerIndicator?: ReactNode;
  /** 聊天头部启用当前项目编辑，其他项目选择器保持原有入口。 */
  showEditProject?: boolean;
  /** 分支等控件位于项目选择器与编辑按钮之间。 */
  children?: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const [workspaceSearchQuery, setWorkspaceSearchQuery] = useState("");
  const showRemoteConnectionEntry = useRemoteConnectionEntryVisibility();
  // Bugfix: Web 普通模式没有完整远程 workspace 会话链路，不能只依赖全局 feature visibility。
  // 这里叠加壳层能力开关，确保本地 Web 模式的空态菜单不会露出必然失败的远程连接入口。
  const canUseRemoteWorkspace =
    allowRemoteWorkspace && showRemoteConnectionEntry && Boolean(onOpenRemoteWorkspace);
  const {
    allProjects,
    projects,
    availability,
    directory,
    deviceNames,
    error,
    service,
    remoteService,
    refresh,
  } = useProjectSelectionDirectory();
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const projectId = useZCodeSessionStore((state) => state.workspaces[workspaceKey]?.draftProjectId);
  const activeTaskId = useZCodeSessionStore(
    (state) => state.workspaces[workspaceKey]?.activeTaskId,
  );
  const createProjectTask: ProjectSidebarProps["onCreateTask"] = (request) =>
    onCreateTask(
      typeof request === "object"
        ? {
            ...request,
            // 远程目录确认曾遗漏草稿分组；两个项目入口必须从同一草稿 owner 读取组织意图。
            taskGroupId: !activeTaskId
              ? useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
                  .draftTaskGroupId
              : null,
          }
        : request,
    );
  const draftVersion = useZCodeSessionStore(
    (state) => state.workspaces[workspaceKey]?.draftFocusVersion,
  );
  // 草稿重建和聊天切换都会使旧返回意图失效，即使后来又回到同一路径也不能复活旧操作。
  const chatKey = JSON.stringify([workspaceKey, activeTaskId, projectId, draftVersion]);
  const currentChat = useRef({ key: chatKey });
  if (currentChat.current.key !== chatKey) currentChat.current = { key: chatKey };
  const chat = currentChat.current;
  const mounted = useRef(true);
  const operation = useRef(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const [connectedDevice, setConnectedDevice] = useState<{
    sourceServerId: string;
    host?: RemoteProjectHost;
    isCurrent(): boolean;
  } | null>(null);
  const setSubmissionPending = useContext(ComposerSubmissionPendingContext);
  const [pending, setPending] = useState(false);
  const [restoredChat, setRestoredChat] = useState<typeof chat | null>(null);
  useEffect(() => {
    setSubmissionPending?.(pending);
    return () => setSubmissionPending?.(false);
  }, [pending, chatKey, setSubmissionPending]);
  useEffect(() => {
    setPending(false);
  }, [chatKey]);
  const cancelSelection = () => {
    setRestoredChat(chat);
    operation.current++;
    setConnectedDevice(null);
    setPending(false);
    setSubmissionPending?.(false);
    setReturnFocus((version) => version + 1);
  };
  const [creating, setCreating] = useState(false);
  const [editingChat, setEditingChat] = useState<typeof chat | null>(null);
  const [returnFocus, setReturnFocus] = useState(0);
  // 旧连接弹窗在被动 effect 中释放焦点锁；layout 阶段聚焦会被拉回即将卸载的按钮。
  // 同轮清理结束后恢复原菜单焦点，不依赖延时，也不移动聊天草稿。
  useEffect(() => {
    if (returnFocus) {
      trigger.current?.focus();
      logger.debug("[ProjectComposerMenu] 返回聊天焦点", {
        restored: document.activeElement === trigger.current,
        inert: Boolean(trigger.current?.closest("[inert]")),
      });
    }
  }, [returnFocus]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const addDevice = () => {
    setRestoredChat(null);
    const request = ++operation.current;
    const originalHosts = directory.hosts;
    let validatedHost: RemoteProjectHost | undefined;
    setConnectedDevice(null);
    setPending(true);
    setSubmissionPending?.(true);
    const isCurrent = () => {
      const draft = useZCodeSessionStore.getState().workspaces[workspaceKey];
      // Store 先提交、React 后渲染；迟到结果不能利用这一间隙复活旧草稿意图。
      return (
        mounted.current &&
        currentChat.current === chat &&
        operation.current === request &&
        draft?.activeTaskId === activeTaskId &&
        draft?.draftProjectId === projectId &&
        draft?.draftFocusVersion === draftVersion
      );
    };
    const accepted = onOpenRemoteWorkspace?.({
      completion: "device-management",
      returnTarget: {
        kind: "add-device",
        isCurrent,
        async canFinish(result) {
          if (!isCurrent()) return false;
          if (result.kind !== "connected" || !result.sourceServerId) return true;
          const hostId = remoteHostIdFromWorkspaceIdentity(
            buildServerRemoteWorkspaceIdentity({
              serverId: result.sourceServerId,
              workspacePath: "/",
            }),
          );
          const original = originalHosts.find((host) => host.id === hostId);
          // 后台等待期间已移除/换代的成员不能借显式继续重新登记；首次设备仍在确认目录时登记。
          if (!original) return true;
          const latest = await remoteService?.readDirectory();
          if (
            !isCurrent() ||
            !latest?.hosts.some(
              (host) => host.id === original.id && host.membershipId === original.membershipId,
            )
          )
            return false;
          validatedHost = original;
          return true;
        },
        onVisibilityChange(visible) {
          if (!isCurrent()) return;
          // 后台连接只保留返回意图；曾因门禁未随收起解除，原草稿无法继续本地工作。
          setPending(visible);
          setSubmissionPending?.(visible);
        },
        finish(result) {
          if (!isCurrent()) return;
          // 连接只证明设备可用；目录与项目仍未确定，不能提前解除原草稿的提交门禁。
          if (result.kind === "connected" && result.sourceServerId) {
            setPending(true);
            setSubmissionPending?.(true);
            setConnectedDevice({
              sourceServerId: result.sourceServerId,
              host: validatedHost,
              isCurrent,
            });
          } else {
            if (result.kind === "cancelled" && !result.background) setRestoredChat(chat);
            setPending(false);
            setSubmissionPending?.(false);
          }
          if (result.kind === "cancelled" && !result.background)
            setReturnFocus((version) => version + 1);
        },
      },
    });
    if (accepted === false) cancelSelection();
  };
  const currentDevice = connectedDevice?.isCurrent() ? connectedDevice : null;
  const hostId = workspaceIdentity ? remoteHostIdFromWorkspaceIdentity(workspaceIdentity) : null;
  // 原因：目录可以属于多个项目，tab/cwd 不能决定归属；只读草稿的项目身份。
  const currentProject = projects.find(
    (project) =>
      project.id === projectId &&
      (hostId ? project.hostId === hostId : !availability.get(projectKey(project))?.entryId),
  );
  const canEditProject =
    showEditProject &&
    currentProject &&
    !currentProject.legacySingleRoot &&
    (availability.get(projectKey(currentProject))?.online ?? true) &&
    Boolean(service);
  const isConversationWorkspace = !currentProject;
  const canDetachProject =
    !hostId &&
    allowConversationWorkspaceSelection &&
    allowConversationWorkspaceDetach &&
    !isConversationWorkspace;
  const visibleProjects = useMemo(() => {
    const query = workspaceSearchQuery.trim().toLowerCase();
    return projects.filter((project) =>
      [
        project.name,
        deviceNames?.get(projectSourceServerId(project) ?? "") ||
          (() => {
            const host = directory.hosts.find((host) => host.id === project.hostId);
            return host ? remoteHostLabel(host) : "";
          })(),
        ...project.roots.map((root) => root.rootPath),
      ].some((text) => text.toLowerCase().includes(query)),
    );
  }, [projects, workspaceSearchQuery, deviceNames, directory.hosts]);
  const currentWorkspaceTitle =
    currentProject?.name ?? intl.formatMessage({ id: "chat.empty.selectProject" });
  const currentWorkspaceIconClassName = cn(
    "size-4 text-foreground-subtle transition-opacity",
    // Bugfix: 关闭按钮和项目图标占用同一位置。只有允许脱离项目时才隐藏底层图标，
    // 否则 X 会直接叠在图标上；定时任务禁用该能力时则让项目图标保持可见。
    canDetachProject &&
      "group-hover/workspace-chip:opacity-0 group-focus-within/workspace-chip:opacity-0",
  );

  const displayProps: ProjectComposerMenuDisplayProps = {
    activeTaskId,
    addDevice,
    allProjects,
    allowConversationWorkspaceSelection,
    availability,
    cancelSelection,
    canDetachProject,
    canEditProject,
    canUseRemoteWorkspace,
    chat,
    children,
    compactForRemoteControl,
    containerClassName,
    createProjectTask,
    creating,
    currentDevice,
    currentProject,
    currentWorkspaceIconClassName,
    currentWorkspaceTitle,
    deviceNames,
    directory,
    editingChat,
    error,
    hostId,
    intl,
    isConversationWorkspace,
    onOpenRemoteWorkspace,
    onSelectConversationWorkspace,
    refresh,
    remoteService,
    restoredChat,
    service,
    setCreating,
    setEditingChat,
    setWorkspaceSearchQuery,
    trigger,
    triggerClassName,
    triggerIndicator,
    visibleProjects,
    workspaceIdentity,
    workspacePath,
    workspaceSearchQuery,
  };
  return <ProjectComposerMenuDisplay {...displayProps} />;
}
