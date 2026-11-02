import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { useComposerClientNamespace } from "@/hooks/useServices.js";
import { readComposerWorkspaceScope } from "@/v4/composer/composerDraftStore.js";
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { OFF_PEAK_DEFAULT_GROUP_ID } from "@zcode/shared";
import { useProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { ProjectTaskListContext } from "@/project-sidebar/ProjectTaskListContext.js";
import type {
  ProjectTask,
  ProjectSidebarProps,
  MoveGroupNode,
  TaskGroupColor,
} from "@/project-sidebar/contract.js";
import { groupTaskRef } from "@/project-sidebar/grouped-view.js";
import {
  readGroupedTaskCollapsedGroupIds,
  persistGroupedTaskCollapsedGroupIds,
} from "@/project-sidebar/grouped-expansion.js";
import { buildGroupedTaskView, groupedMoveCommand } from "@/project-sidebar/grouped/model.js";
import { useGroupedDrag } from "@/project-sidebar/grouped/useGroupedDrag.js";
import { TaskGroupedViewFrame } from "@/project-sidebar/TaskGroupedViewFrame.js";
import {
  findNearestScrollableAncestor,
  resolveStickyGroupedTaskGroupId,
} from "@/project-sidebar/grouped/drag.js";
import { taskKey } from "@/project-sidebar/grouped/ids.js";
import {
  findTaskInGroupedView,
  moveTaskByMenu,
  moveTaskToTopByMenu,
} from "@/project-sidebar/grouped/view.js";
import { mutateProjectTask, type ProjectTaskMutation } from "@/project-sidebar/task-mutation.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { resolveRemoteWorkspaceSessionIdForTarget } from "@/hooks/useResolvedRemoteWorkspaceSessionId.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  clearV4ComposerDraftTaskGroup,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
} from "@/v4/composer/composerDraftStore.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";

/** 恢复删除前的组件与手势（fd2f4f38a4a^1）；仅将旧事实缓存/applyOrder 改接当前 owner。 */
export function TaskGroupedView({
  tasks,
  onSelect,
  refresh,
  onCreate,
  workspacePath,
  workspaceIdentity,
  onOpenAutomations,
  toolbarTarget,
  stickyTarget,
  scrollRef,
}: {
  tasks: ProjectTask[];
  onSelect: ProjectSidebarProps["onSelectTask"];
  refresh(): Promise<void>;
  onCreate(groupId: string | null): void;
  workspacePath: string;
  workspaceIdentity?: string;
  onOpenAutomations?: () => void;
  toolbarTarget: HTMLElement | null;
  stickyTarget: HTMLElement | null;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const { groups: organization, loading } = useProjectDirectory();
  const { intl } = useZCodeIntl();
  const presentation = useContext(ProjectTaskListContext);
  const { zcodeTaskService: service, windowControllerService: controller } =
    useBaseWorkspaceServices();
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const composerClientNamespace = useComposerClientNamespace();
  const draftScope = readComposerWorkspaceScope(
    workspacePath,
    workspaceIdentity,
    composerClientNamespace,
  );
  const activeTaskId = useZCodeSessionStore(
    (state) => state.workspaces[workspaceKey]?.activeTaskId ?? null,
  );
  const draftFocusVersion = useZCodeSessionStore(
    (state) => state.workspaces[workspaceKey]?.draftFocusVersion,
  );
  // 空正文不再持久化；分组行订阅现有内存草稿，不能靠 localStorage 或手动重绘维持归属。
  const currentDraftGroupId = useZCodeSessionStore(
    (state) => state.workspaces[workspaceKey]?.draftTaskGroupId,
  );
  // 查看会话时仅显示尚未提交的文字草稿；首发已移除保存记录，不能复活旧的内存 placement。
  const draftGroupId = activeTaskId
    ? readV4ComposerDraft(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT, draftScope)
        ?.taskGroupId
    : currentDraftGroupId;
  const [collapsed, setCollapsed] = useState(readGroupedTaskCollapsedGroupIds);
  const changeCollapsed = useCallback<Dispatch<SetStateAction<Set<string>>>>((update) => {
    setCollapsed((current) => (typeof update === "function" ? update(current) : update));
  }, []);
  useEffect(() => {
    persistGroupedTaskCollapsedGroupIds(collapsed);
  }, [collapsed]);
  const [newGroupSetupId, setNewGroupSetupId] = useState<string | null>(null);
  const [renamingTask, setRenamingTask] = useState<ProjectTask | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!renamingTask) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renamingTask]);
  const remoteState = useRemoteWorkspaceSessionStore(
    useShallow((state) => ({
      sessionsById: state.sessionsById,
      sessionIdByWorkspaceIdentity: state.sessionIdByWorkspaceIdentity,
      sessionIdByWorkspacePath: state.sessionIdByWorkspacePath,
    })),
  );
  const getTaskRemoteSessionId = useCallback(
    (task: ProjectTask) => {
      // 只解析既有 attachment；完整 identity 阻止同路径的另一远端串线。
      return (
        resolveRemoteWorkspaceSessionIdForTarget({
          ...task,
          state: remoteState,
        }) ?? undefined
      );
    },
    [remoteState],
  );
  const authoritativeView = useMemo(
    () => buildGroupedTaskView(tasks, organization.structure),
    [tasks, organization.structure],
  );
  const report = (error: unknown, messageId = "taskGroup.updateFailed") => {
    logger.error("[task-groups] 分组操作失败", error);
    toast(intl.formatMessage({ id: messageId }));
  };
  const action = (work: () => Promise<unknown>, messageId?: string) => {
    void work().catch((error) => report(error, messageId));
  };
  const move = async (command: MoveGroupNode) => {
    try {
      await organization.move(command);
    } catch (error) {
      report(error);
      await organization.refresh();
    }
  };
  const drag = useGroupedDrag({
    authoritativeView,
    collapsedGroupIds: collapsed,
    onCollapsedGroupIdsChange: changeCollapsed,
    onMove: move,
  });
  const selectGroups = useShallow((nodes: typeof drag.view.nodes) =>
    nodes.flatMap((node) => (node.type === "group" ? [node.group] : [])),
  );
  const groups = selectGroups(drag.view.nodes);
  const allExpanded = groups.every((group) => !collapsed.has(group.id));
  const toggleCollapsed = (id: string) =>
    changeCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const createTask = (groupId: string | null) => {
    if (groupId === OFF_PEAK_DEFAULT_GROUP_ID) {
      onOpenAutomations?.();
      return;
    }
    if (groupId)
      changeCollapsed((current) => {
        const next = new Set(current);
        next.delete(groupId);
        return next;
      });
    onCreate(groupId);
  };
  const closeDraft = () => {
    clearV4ComposerDraftTaskGroup(workspacePath, workspaceIdentity, draftScope);
    useZCodeSessionStore.getState().clearDraftTaskGroup(workspacePath, workspaceIdentity);
  };
  useEffect(() => {
    if (draftGroupId !== null || !drag.root.current) return;
    const root = drag.root.current;
    const frame = requestAnimationFrame(() =>
      findNearestScrollableAncestor(root)?.scrollTo({ top: 0 }),
    );
    return () => cancelAnimationFrame(frame);
  }, [draftFocusVersion, draftGroupId, drag.root]);
  const mutate = async (task: ProjectTask, mutation: ProjectTaskMutation) => {
    const result = await mutateProjectTask(
      { service, controller },
      task,
      mutation,
      getTaskRemoteSessionId(task),
    );
    if (mutation.kind === "archive" && mutation.archived)
      useZCodeSessionStore
        .getState()
        .removeTaskState(task.workspacePath, task.taskId, task.workspaceIdentity);
    await refresh();
    return result;
  };
  const moveTask = (task: ProjectTask, groupId?: string | null) => {
    const next =
      groupId === undefined
        ? moveTaskToTopByMenu(authoritativeView, task)
        : moveTaskByMenu(authoritativeView, task, groupId);
    const command = groupedMoveCommand(authoritativeView, next, {
      type: "task",
      task: groupTaskRef(task),
    });
    if (command) void move(command);
  };
  const updateColor = (id: string, color: TaskGroupColor) =>
    action(() => organization.save({ id, color }));
  const ungroup = (id: string) => action(() => organization.ungroup(id));
  const getWorkspaceLabel = (task: Pick<ProjectTask, "workspacePath" | "workspacePurpose">) =>
    task.workspacePurpose === "conversation"
      ? intl.formatMessage({ id: "workspaceSidebar.conversationsSection" })
      : task.workspacePath.split(/[\\/]/).filter(Boolean).at(-1) || task.workspacePath;
  const rowActions = {
    onSelectTask: (path: string, id: string, identity?: string) => {
      const task = findTaskInGroupedView(
        authoritativeView,
        taskKey({ workspacePath: path, taskId: id, workspaceIdentity: identity }),
      );
      onSelect(path, id, identity, task ? getTaskRemoteSessionId(task) : undefined, task?.unreadAt);
    },
    onCloseTask: (task: ProjectTask) =>
      action(() => mutate(task, { kind: "archive", archived: true }), "taskList.archiveFailed"),
    onArchiveTask: (task: ProjectTask) =>
      action(() => mutate(task, { kind: "archive", archived: true }), "taskList.archiveFailed"),
    onOpenFileTree: presentation.onOpenTaskFiles
      ? (task: ProjectTask) =>
          action(() => presentation.onOpenTaskFiles!(task, getTaskRemoteSessionId(task)))
      : undefined,
    onMoveTaskToGroup: (task: ProjectTask, id: string | null) => moveTask(task, id),
    onMoveTaskToTop: (task: ProjectTask) => moveTask(task),
    onStartRenameTask: (task: ProjectTask) => {
      setRenamingTask(task);
      setRenameDraft(task.title ?? "");
    },
    onMarkTaskAsUnread: (task: ProjectTask) =>
      action(() => mutate(task, { kind: "mark-unread" }), "taskList.markAsUnreadFailed"),
  };
  // Bug 根因：一条任务活动会重建整组行回调，击穿所有未变任务的 memo。
  // 行事件只转发到最近已提交的实现，既稳定引用，也不捕获过期的任务/分组和远端地址。
  const rowActionsRef = useRef(rowActions);
  useLayoutEffect(() => {
    rowActionsRef.current = rowActions;
  });
  const stableRowActions = useMemo(
    () => ({
      onSelectTask: (...args: Parameters<typeof rowActions.onSelectTask>) =>
        rowActionsRef.current.onSelectTask(...args),
      onCloseTask: (task: ProjectTask) => rowActionsRef.current.onCloseTask(task),
      onArchiveTask: (task: ProjectTask) => rowActionsRef.current.onArchiveTask(task),
      onOpenFileTree: (task: ProjectTask) => rowActionsRef.current.onOpenFileTree?.(task),
      onMoveTaskToGroup: (task: ProjectTask, id: string | null) =>
        rowActionsRef.current.onMoveTaskToGroup(task, id),
      onMoveTaskToTop: (task: ProjectTask) => rowActionsRef.current.onMoveTaskToTop(task),
      onStartRenameTask: (task: ProjectTask) => rowActionsRef.current.onStartRenameTask(task),
      onMarkTaskAsUnread: (task: ProjectTask) => rowActionsRef.current.onMarkTaskAsUnread(task),
    }),
    [],
  );
  const rowCallbacks = {
    ...stableRowActions,
    onOpenFileTree: presentation.onOpenTaskFiles ? stableRowActions.onOpenFileTree : undefined,
    groups,
    tooltipsDisabled: drag.dragging,
  };
  // Bug 根因：首发接纳改变全局 activeTaskId，传到每行会连未选中行的外层一起刷新。
  // 在列表装配时派生行自身选中状态，保持整条无关行的 memo 输入不变。
  const rowSelection = (task: ProjectTask) => {
    const key = buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity);
    return {
      isActive:
        buildTaskWorkspaceKey(workspacePath, workspaceIdentity) === key &&
        activeTaskId === task.taskId,
      isMobileActive: presentation.mobileActiveTaskKey === `${key}:${task.taskId}`,
    };
  };
  const [stickyId, setStickyId] = useState<string | null>(null);
  useEffect(() => {
    const root = drag.root.current;
    if (!root || drag.dragging) {
      setStickyId(null);
      return;
    }
    // 展开动画首帧尚无 overflow，不能因此漏订阅后续滚动；当前滚动 owner 由侧栏直接提供。
    const scroll = scrollRef.current;
    if (!scroll) {
      setStickyId(null);
      return;
    }
    let frame: number | null = null;
    const update = () => {
      frame = null;
      setStickyId(resolveStickyGroupedTaskGroupId(root));
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(update);
    };
    update();
    scroll.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      scroll.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
    };
  }, [scrollRef, drag.root, drag.dragging, drag.view.nodes, collapsed, draftGroupId]);
  const sticky = drag.view.nodes.find(
    (node) => node.type === "group" && node.group.id === stickyId,
  );
  const activeTask = drag.activeTaskKey
    ? findTaskInGroupedView(drag.view, drag.activeTaskKey)
    : null;
  const activeGroup = drag.view.nodes.find(
    (node) => node.type === "group" && node.group.id === drag.activeGroupId,
  );
  const overlayStyle = drag.width ? { width: `${drag.width}px` } : undefined;
  const toggleLabel = intl.formatMessage({
    id: allExpanded ? "taskGroup.collapseAll" : "taskGroup.expandAll",
  });
  return (
    <TaskGroupedViewFrame
      toolbarTarget={toolbarTarget}
      stickyTarget={stickyTarget}
      workspacePath={workspacePath}
      workspaceIdentity={workspaceIdentity}
      intl={intl}
      presentation={presentation}
      organization={organization}
      loading={loading}
      drag={drag}
      groups={groups}
      collapsed={collapsed}
      changeCollapsed={changeCollapsed}
      allExpanded={allExpanded}
      toggleLabel={toggleLabel}
      toggleCollapsed={toggleCollapsed}
      createTask={createTask}
      closeDraft={closeDraft}
      draftGroupId={draftGroupId}
      activeTaskId={activeTaskId}
      getWorkspaceLabel={getWorkspaceLabel}
      getTaskRemoteSessionId={getTaskRemoteSessionId}
      rowCallbacks={rowCallbacks}
      rowSelection={rowSelection}
      newGroupSetupId={newGroupSetupId}
      setNewGroupSetupId={setNewGroupSetupId}
      updateColor={updateColor}
      ungroup={ungroup}
      action={action}
      mutate={mutate}
      sticky={sticky}
      activeTask={activeTask}
      activeGroup={activeGroup}
      overlayStyle={overlayStyle}
      renamingTask={renamingTask}
      renameDraft={renameDraft}
      renameInputRef={renameInputRef}
      setRenamingTask={setRenamingTask}
      setRenameDraft={setRenameDraft}
    />
  );
}
