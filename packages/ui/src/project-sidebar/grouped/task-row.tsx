import type { ProjectTask as ZCodeTaskMeta } from "@/project-sidebar/contract.js";
import { memo, useRef, useState } from "react";
import type { FocusEvent, KeyboardEvent, MouseEvent } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import type { UniqueIdentifier } from "@dnd-kit/core";
import { isCronTask, isOffPeakTask } from "@zcode/shared";
import { Cloud, Folder } from "lucide-react";
import { ContextMenu } from "@/components/ui/context-menu.js";
import { Tooltip, TooltipContent } from "@/components/ui/tooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  deriveTaskLeadingIndicator,
  formatTaskRelativeTime,
} from "@/lib/taskListItemPresentation.js";
import { getTaskChangeSummary } from "@/lib/taskChangeSummary.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { useTaskListItemContextActions } from "@/useTaskListItemContextActions.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { getTaskListAttention, getTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import { GroupedTaskContextMenuContent } from "@/project-sidebar/grouped/task-context-menu-content.js";
import { TaskRowContent } from "@/project-sidebar/grouped/TaskRowContent.js";
import { TaskRowPreview } from "@/project-sidebar/grouped/TaskRowPreview.js";
import { formatGroupedTaskHoverChangeParts } from "@/project-sidebar/grouped/task-row-tooltip.js";
import type { TaskGroupMenuItem } from "@/project-sidebar/grouped/types.js";
import { TaskWorkflowRunLines } from "@/components/workflow-run-line/TaskWorkflowRunLines.js";
import { useTaskInteractionAutoResolutionSnooze } from "@/hooks/useTaskInteractionAutoResolutionSnooze.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceReadOnly } from "@/store/tabStore.js";

function GroupedTaskRowComponent({
  task,
  currentGroupId,
  groups,
  remoteSessionId,
  isActive,
  isMobileActive,
  workspaceLabel,
  onSelectTask,
  onCloseTask,
  onOpenFileTree,
  onMoveTaskToGroup,
  onMoveTaskToTop,
  onStartRenameTask,
  onArchiveTask,
  onMarkTaskAsUnread,
  dragId,
  dragging,
  dragOverlay,
  tooltipsDisabled,
}: {
  task: ZCodeTaskMeta;
  currentGroupId?: string;
  groups: TaskGroupMenuItem[];
  remoteSessionId?: string;
  isActive: boolean;
  isMobileActive: boolean;
  workspaceLabel: string;
  onSelectTask: (workspacePath: string, taskId: string, workspaceIdentity?: string) => void;
  onCloseTask: (task: ZCodeTaskMeta) => void;
  onOpenFileTree?: (task: ZCodeTaskMeta) => void;
  onMoveTaskToGroup: (task: ZCodeTaskMeta, groupId: string | null) => void;
  onMoveTaskToTop: (task: ZCodeTaskMeta) => void;
  onStartRenameTask: (task: ZCodeTaskMeta) => void;
  onArchiveTask: (task: ZCodeTaskMeta) => void;
  onMarkTaskAsUnread: (task: ZCodeTaskMeta) => void;
  dragId?: UniqueIdentifier;
  dragging?: boolean;
  dragOverlay?: boolean;
  tooltipsDisabled?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const workspaceActionsDisabled = useOptionalTabStore((state) =>
    isWorkspaceReadOnly(state, task.workspacePath, task.workspaceIdentity),
  );
  const workspaceActionsDisabledReason = workspaceActionsDisabled
    ? intl.formatMessage({ id: "workspaceSidebar.unavailableLocalDirectory" })
    : undefined;
  const snoozeInteractionAutoResolution = useTaskInteractionAutoResolutionSnooze({
    workspacePath: task.workspacePath,
    ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
    sessionId: task.taskId,
  });
  const workspaceKey = buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity);
  const taskActivity = getTaskListRowActivity(task);
  const taskAttention = getTaskListAttention(task);
  // 交互胶囊是当前最高优先级的右侧状态；无论来自 sessions-index 摘要还是
  // activity attention，都不应再并排显示相对时间并挤压任务标题。
  const hasPendingInteraction = Boolean(task.pendingInteraction) || taskAttention !== null;
  // Bugfix：远端 session 未就绪时打开文件树必然会被 resolver 拒绝，因此不要暴露
  // 无效 action；本地 task 不需要 remoteSessionId，仍保持入口可用。
  const canOpenFileTree =
    Boolean(onOpenFileTree) && (!task.workspaceIdentity?.trim() || Boolean(remoteSessionId));
  const taskAttentionLabel = taskAttention
    ? intl.formatMessage({
        id: taskAttention.kind === "userInput" ? "taskList.userInputTag" : "taskList.permissionTag",
      })
    : null;
  const taskAttentionDisplay =
    taskAttention && taskAttentionLabel && taskAttention.count > 1
      ? intl.formatMessage(
          { id: "taskList.attentionCount" },
          { label: taskAttentionLabel, count: String(taskAttention.count) },
        )
      : taskAttentionLabel;
  const leadingIndicator = deriveTaskLeadingIndicator(task, taskActivity);
  const taskTitle =
    task.title ||
    intl.formatMessage({
      id: task.forkedFromTaskId ? "taskList.forkedUntitled" : "taskList.untitled",
    });
  const taskChangeParts = formatGroupedTaskHoverChangeParts(getTaskChangeSummary(task));
  const taskTimeLabel = formatTaskRelativeTime(task.updatedAt, intl);
  const isTaskCron = isCronTask(task);
  // 月亮身份改为持久 meta 标记判断；off-peak store 反查在任务被删除后会丢失
  // 会话溯源，且让每一行多背一个全局 store 订阅。
  const isTaskOffPeak = isOffPeakTask(task);
  const statusDotClassName =
    leadingIndicator === "error"
      ? "bg-destructive"
      : leadingIndicator === "unread"
        ? // Bugfix: grouped task 未读点需要和普通 task list 共用 sky 色，避免 brand 色在不同主题下表达漂移。
          "bg-sky-500 dark:bg-sky-400"
        : null;
  const canShowHoverActions = !dragOverlay;
  // 工作流运行行：分组行同样长在标题下；
  // drag overlay 只是纯展示，不挂确认副作用与点击入口。
  const workflowRunLinesNode =
    taskActivity?.workflowActivity && !dragOverlay ? (
      <TaskWorkflowRunLines
        activity={taskActivity.workflowActivity}
        isActive={isActive}
        intl={intl}
        session={{
          workspacePath: task.workspacePath,
          ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
          sessionId: task.taskId,
        }}
      />
    ) : null;

  const taskRow = (
    <TaskRowPreview
      dragOverlay={dragOverlay}
      isMobileActive={isMobileActive}
      isActive={isActive}
      dragging={dragging}
      canShowHoverActions={canShowHoverActions}
      taskTitle={taskTitle}
      task={task}
      intl={intl}
      snoozeInteractionAutoResolution={snoozeInteractionAutoResolution}
      taskAttentionDisplay={taskAttentionDisplay}
      leadingIndicator={leadingIndicator}
      statusDotClassName={statusDotClassName}
      hasPendingInteraction={hasPendingInteraction}
      isTaskCron={isTaskCron}
      isTaskOffPeak={isTaskOffPeak}
      taskTimeLabel={taskTimeLabel}
    />
  );

  // DragOverlay 高频渲染时只返回纯展示节点，避免隐藏 action tooltip 的 Radix ref 循环和 task 路径 RPC。
  if (dragOverlay) return taskRow;

  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [taskRowHovered, setTaskRowHovered] = useState(false);
  const [taskRowFocusWithin, setTaskRowFocusWithin] = useState(false);
  // 右键菜单关闭后 Radix 会把焦点脚本式返还给触发行；该焦点不是用户的键盘焦点，
  // 若据此展示 action，鼠标移开后行内 action 会一直残留，需在 contextmenu 时记账忽略。
  const ignoreRestoredFocusRef = useRef(false);
  const [isHoverNone] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(hover: none)").matches,
  );
  const platform = usePlatform();
  const {
    taskSessionFile,
    taskNativeSessionLogFile,
    providerConfigFile,
    fileManagerLabel,
    handleCopyText,
    handleCopyWorkspacePath,
    handleOpenTaskPathInFileManager,
    handleOpenProviderConfig,
  } = useTaskListItemContextActions({
    workspacePath: task.workspacePath,
    remoteSessionId,
    workspaceIdentity: task.workspaceIdentity,
    taskId: task.taskId,
    provider: task.provider,
    intl,
    loadTaskPaths: contextMenuOpen,
    loadProviderConfig: contextMenuOpen,
  });
  const handleSelect = () => {
    onSelectTask(task.workspacePath, task.taskId, task.workspaceIdentity);
  };
  const handleCloseTask = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (workspaceActionsDisabled) {
      return;
    }
    onCloseTask(task);
  };
  const handleOpenFileTree = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (workspaceActionsDisabled) {
      return;
    }
    onOpenFileTree?.(task);
  };
  const handleMoveTaskToTop = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (workspaceActionsDisabled) {
      return;
    }
    onMoveTaskToTop(task);
  };
  const handleOpenTaskFeedback = () => platform.openFeedback();
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    handleSelect();
  };
  const handleRowContextMenu = () => {
    ignoreRestoredFocusRef.current = true;
  };
  const handleRowFocusCapture = (event: FocusEvent<HTMLDivElement>) => {
    if (ignoreRestoredFocusRef.current) {
      ignoreRestoredFocusRef.current = false;
      return;
    }
    // 仅键盘焦点展示行内 action：鼠标点击带来的聚焦在鼠标移开后应随 hover 一起消失；
    // Tab 导航仍会聚焦并展示 action。
    if (event.target instanceof Element && event.target.matches(":focus-visible")) {
      setTaskRowFocusWithin(true);
    }
  };
  const handleRowBlurCapture = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setTaskRowFocusWithin(false);
    }
  };
  const dragDisabled = workspaceActionsDisabled || !dragId || contextMenuOpen || dragOverlay;
  const draggable = useDraggable({
    id: dragId ?? `disabled:${workspaceKey}:${task.taskId}`,
    disabled: dragDisabled,
    data: { type: "grouped-task", taskKey: dragId },
  });
  const droppable = useDroppable({
    id: dragId ?? `disabled-drop:${workspaceKey}:${task.taskId}`,
    disabled: workspaceActionsDisabled || !dragId || dragOverlay,
    data: { type: "grouped-task", taskKey: dragId },
  });

  const setTaskRowRef = (element: HTMLDivElement | null) => {
    draggable.setNodeRef(element);
    droppable.setNodeRef(element);
  };
  const groupedTaskDomKey = typeof dragId === "string" ? encodeURIComponent(dragId) : undefined;
  // Bug 原因：CSS hidden → flex 会让 action trigger 在 pointer 到达时才获得布局尺寸，
  // Tooltip Portal 可能先以未定位坐标绘制。改为交互状态决定 action 是否挂载，
  // 同时保留键盘、触摸设备和手机远控 active task 的入口。
  const shouldMountHoverActions =
    !task.pendingInteraction &&
    (taskRowHovered || taskRowFocusWithin || isHoverNone || isMobileActive);
  // 触屏端 isHoverNone 只负责常驻 action；时间、状态点和 cron/off-peak 元信息
  // 仍应保留，仅在真实 hover / focus 交互时让位，避免手机端永久丢失任务状态。
  const shouldSuppressTaskMetadata = taskRowHovered || taskRowFocusWithin;

  const interactiveTaskRow = (
    <TaskRowContent
      tooltipsDisabled={tooltipsDisabled}
      rowRef={setTaskRowRef}
      draggable={draggable}
      onSelect={handleSelect}
      onKeyDown={handleKeyDown}
      onRowMouseEnter={() => setTaskRowHovered(true)}
      onRowMouseLeave={() => setTaskRowHovered(false)}
      onRowContextMenu={handleRowContextMenu}
      onRowFocusCapture={handleRowFocusCapture}
      onRowBlurCapture={handleRowBlurCapture}
      groupedTaskDomKey={groupedTaskDomKey}
      task={task}
      isMobileActive={isMobileActive}
      isActive={isActive}
      dragging={dragging}
      taskTitle={taskTitle}
      intl={intl}
      snoozeInteractionAutoResolution={snoozeInteractionAutoResolution}
      taskAttentionDisplay={taskAttentionDisplay}
      shouldSuppressTaskMetadata={shouldSuppressTaskMetadata}
      leadingIndicator={leadingIndicator}
      statusDotClassName={statusDotClassName}
      hasPendingInteraction={hasPendingInteraction}
      isTaskCron={isTaskCron}
      isTaskOffPeak={isTaskOffPeak}
      taskTimeLabel={taskTimeLabel}
      shouldMountHoverActions={shouldMountHoverActions}
      canOpenFileTree={canOpenFileTree}
      workspaceActionsDisabledReason={workspaceActionsDisabledReason}
      onOpenFileTree={handleOpenFileTree}
      onMoveTaskToTop={handleMoveTaskToTop}
      onCloseTask={handleCloseTask}
      workflowRunLinesNode={workflowRunLinesNode}
    />
  );

  // grouped row 不能用原生 button 承载整行；行内还有菜单、关闭、文件树等 button，外层继续用 role=button，避免嵌套 button 破坏键盘和右键菜单语义。
  return (
    <ContextMenu onOpenChange={setContextMenuOpen}>
      {tooltipsDisabled ? (
        // overlay 拖拽时指针下方的真实 row 仍可能被 Radix 识别为 hover，跳过 TooltipTrigger 避免底层 row 或 action 弹出悬浮提示。
        interactiveTaskRow
      ) : (
        <Tooltip>
          {interactiveTaskRow}
          <TooltipContent side="right" align="center" sideOffset={6}>
            {remoteSessionId ? (
              <Cloud aria-hidden="true" className="size-3.5 shrink-0" />
            ) : (
              <Folder aria-hidden="true" className="size-3.5 shrink-0" />
            )}
            <span className="min-w-0 max-w-48 truncate">{workspaceLabel}</span>
            {taskChangeParts.length > 0 ? (
              <>
                <span className="text-tooltip-foreground/60">·</span>
                <span className="inline-flex shrink-0 items-center gap-1">
                  {taskChangeParts.map((part) => (
                    <span
                      key={part}
                      className={part.startsWith("+") ? "text-diff-added" : "text-diff-removed"}
                    >
                      {part}
                    </span>
                  ))}
                </span>
              </>
            ) : null}
          </TooltipContent>
        </Tooltip>
      )}
      {contextMenuOpen ? (
        // 右键菜单内容带 Radix Presence/Portal，拖拽重排时常驻挂载会触发嵌套更新循环；仅在菜单打开时挂载内容，配合路径懒加载避免拖拽过程刷 task path RPC。
        <GroupedTaskContextMenuContent
          task={task}
          currentGroupId={currentGroupId}
          groups={groups}
          intl={intl}
          fileManagerLabel={fileManagerLabel}
          taskSessionFile={taskSessionFile}
          taskNativeSessionLogFile={taskNativeSessionLogFile}
          providerConfigFile={providerConfigFile}
          onMoveTaskToGroup={onMoveTaskToGroup}
          onMoveTaskToTop={onMoveTaskToTop}
          onStartRenameTask={onStartRenameTask}
          onArchiveTask={onArchiveTask}
          onMarkTaskAsUnread={onMarkTaskAsUnread}
          onOpenTaskPathInFileManager={() => void handleOpenTaskPathInFileManager()}
          onCopyWorkspacePath={() =>
            void handleCopyWorkspacePath(intl.formatMessage({ id: "appHeader.copyPath" }))
          }
          onCopyText={(label, text) => void handleCopyText(label, text)}
          onOpenProviderConfig={() => void handleOpenProviderConfig()}
          onOpenTaskFeedback={() => void handleOpenTaskFeedback()}
          disabledReason={workspaceActionsDisabledReason}
        />
      ) : null}
    </ContextMenu>
  );
}
export const GroupedTaskRow = memo(GroupedTaskRowComponent);
