import { ContextMenuTrigger } from "@/components/ui/context-menu.js";
import { TooltipTrigger } from "@/components/ui/tooltip.js";
import { TID_TASK_ITEM, testId } from "@zcode/shared/test-ids";
import type { ProjectTask as ZCodeTaskMeta } from "@/project-sidebar/contract.js";
import type { FocusEvent, KeyboardEvent, MouseEvent, ReactNode } from "react";
import type { DraggableAttributes, DraggableSyntheticListeners } from "@dnd-kit/core";
import { ArrowUpToLine, Clock, ListTree, LoaderIcon, Moon, X } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Badge } from "@/components/ui/badge.js";
import { TaskTitleOverflowText } from "@/components/TaskTitleOverflowText.js";
import { TaskInteractionBadge } from "@/TaskInteractionBadge.js";
import { TaskRowActionButton } from "@/workspace-grouped-tasks/task-row-action-button.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import {
  TASK_GROUP_ROW_CLASS,
  TASK_GROUP_ROW_LINE_CLASS,
} from "@/project-sidebar/grouped/types.js";

interface TaskRowContentProps {
  tooltipsDisabled?: boolean;
  rowRef: (element: HTMLDivElement | null) => void;
  draggable: {
    attributes: DraggableAttributes;
    listeners: DraggableSyntheticListeners;
  };
  onSelect: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onRowMouseEnter: () => void;
  onRowMouseLeave: () => void;
  onRowContextMenu: () => void;
  onRowFocusCapture: (event: FocusEvent<HTMLDivElement>) => void;
  onRowBlurCapture: (event: FocusEvent<HTMLDivElement>) => void;
  groupedTaskDomKey: string | undefined;
  task: ZCodeTaskMeta;
  isMobileActive: boolean;
  isActive: boolean;
  dragging?: boolean;
  taskTitle: string;
  intl: IntlInstance;
  snoozeInteractionAutoResolution: (interactionId: string) => boolean | Promise<boolean>;
  taskAttentionDisplay: string | null;
  shouldSuppressTaskMetadata: boolean;
  leadingIndicator: "error" | "unread" | "loading" | "none";
  statusDotClassName: string | null;
  hasPendingInteraction: boolean;
  isTaskCron: boolean;
  isTaskOffPeak: boolean;
  taskTimeLabel: string;
  shouldMountHoverActions: boolean;
  canOpenFileTree: boolean;
  workspaceActionsDisabledReason: string | undefined;
  onOpenFileTree: (event: MouseEvent<HTMLButtonElement>) => void;
  onMoveTaskToTop: (event: MouseEvent<HTMLButtonElement>) => void;
  onCloseTask: (event: MouseEvent<HTMLButtonElement>) => void;
  workflowRunLinesNode: ReactNode;
}

/**
 * 分组任务行的纯展示内容：只渲染，不持有 state、不读取服务、不反向依赖父级。
 * 展示值与 handler 全部由 grouped/task-row.tsx 显式传入，DOM、class、test-id 与事件顺序保持不变。
 */
export function TaskRowContent({
  tooltipsDisabled,
  rowRef,
  draggable,
  onSelect,
  onKeyDown,
  onRowMouseEnter,
  onRowMouseLeave,
  onRowContextMenu,
  onRowFocusCapture,
  onRowBlurCapture,
  groupedTaskDomKey,
  task,
  isMobileActive,
  isActive,
  dragging,
  taskTitle,
  intl,
  snoozeInteractionAutoResolution,
  taskAttentionDisplay,
  shouldSuppressTaskMetadata,
  leadingIndicator,
  statusDotClassName,
  hasPendingInteraction,
  isTaskCron,
  isTaskOffPeak,
  taskTimeLabel,
  shouldMountHoverActions,
  canOpenFileTree,
  workspaceActionsDisabledReason,
  onOpenFileTree,
  onMoveTaskToTop,
  onCloseTask,
  workflowRunLinesNode,
}: TaskRowContentProps) {
  const row = (
    <div
      ref={rowRef}
      {...draggable.attributes}
      {...draggable.listeners}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      onMouseEnter={onRowMouseEnter}
      onMouseLeave={onRowMouseLeave}
      onContextMenu={onRowContextMenu}
      onFocusCapture={onRowFocusCapture}
      onBlurCapture={onRowBlurCapture}
      data-grouped-task-key={groupedTaskDomKey}
      data-testid={testId(TID_TASK_ITEM, task.taskId)}
      data-task-item-key={groupedTaskDomKey}
      data-mobile-active-task={isMobileActive ? "true" : undefined}
      className={cn(
        "group/task-row",
        TASK_GROUP_ROW_CLASS,
        "cursor-pointer",
        isActive ? "bg-selected" : "hover:bg-surface-hover",
        dragging && "opacity-0",
      )}
    >
      <span className={TASK_GROUP_ROW_LINE_CLASS}>
        <TaskTitleOverflowText as="span" className="text-foreground" title={taskTitle}>
          {/* Bugfix: grouped task 标题超出时不要显示省略号，右侧渐隐能保留标题连续性，避免和右侧状态元信息挤在一起。 */}
          {taskTitle}
        </TaskTitleOverflowText>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-ui-sm text-foreground-subtle">
          {task.pendingInteraction ? (
            <TaskInteractionBadge
              interaction={task.pendingInteraction}
              formatMessage={(id) => intl.formatMessage({ id })}
              onSnoozeCountdown={snoozeInteractionAutoResolution}
            />
          ) : taskAttentionDisplay && !shouldSuppressTaskMetadata ? (
            <Badge className="h-5 border-transparent bg-success/14 px-2 text-ui-base font-medium text-success dark:bg-success/18">
              {taskAttentionDisplay}
            </Badge>
          ) : null}
          {!shouldSuppressTaskMetadata ? (
            <span className="flex shrink-0 items-center gap-1">
              {leadingIndicator === "loading" ? (
                <LoaderIcon className="size-3.5 animate-spin text-foreground-subtle" />
              ) : statusDotClassName ? (
                <span
                  aria-hidden="true"
                  className="flex size-4 shrink-0 items-center justify-center"
                >
                  <span className={cn("size-1.5 rounded-full", statusDotClassName)} />
                </span>
              ) : null}
              {!hasPendingInteraction && isTaskCron ? (
                // 可交互 grouped row 之前漏渲染 clock，导致 Projects 分组里的定时任务没有 icon。
                // 这里和普通 task list 一样放在时间前面，同时不再被未读/运行状态顶掉。
                <Clock
                  data-cron-task-icon="true"
                  aria-label={intl.formatMessage({ id: "taskList.cronTaskLabel" })}
                  className="size-3.5 shrink-0"
                />
              ) : !hasPendingInteraction && isTaskOffPeak ? (
                <Moon
                  data-off-peak-task-icon="true"
                  aria-label={intl.formatMessage({ id: "taskList.offPeakTaskLabel" })}
                  className="size-3.5 shrink-0"
                />
              ) : null}
              {!hasPendingInteraction ? <span className="mr-1">{taskTimeLabel}</span> : null}
            </span>
          ) : null}
          {shouldMountHoverActions ? (
            <span className="flex shrink-0 items-center gap-0.5">
              {canOpenFileTree ? (
                <TaskRowActionButton
                  label={intl.formatMessage({ id: "git.action.showTree" })}
                  onClick={onOpenFileTree}
                  showTooltip
                  disabledReason={workspaceActionsDisabledReason}
                >
                  <ListTree className="size-3.5" />
                </TaskRowActionButton>
              ) : null}
              <TaskRowActionButton
                label={intl.formatMessage({ id: "taskGroup.moveToTop" })}
                onClick={onMoveTaskToTop}
                showTooltip
                disabledReason={workspaceActionsDisabledReason}
              >
                <ArrowUpToLine className="size-3.5" />
              </TaskRowActionButton>
              <TaskRowActionButton
                label={intl.formatMessage({ id: "common.close" })}
                onClick={onCloseTask}
                showTooltip
                disabledReason={workspaceActionsDisabledReason}
              >
                <X className="size-3.5" />
              </TaskRowActionButton>
            </span>
          ) : null}
        </span>
      </span>
      {workflowRunLinesNode}
    </div>
  );
  // Bug 原因：asChild 包住普通展示函数会丢弃 Radix 注入的事件/ref；直接包住原 DOM。
  const trigger = <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>;
  return tooltipsDisabled ? trigger : <TooltipTrigger asChild>{trigger}</TooltipTrigger>;
}
