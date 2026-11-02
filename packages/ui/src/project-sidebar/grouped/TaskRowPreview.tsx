import type { ProjectTask as ZCodeTaskMeta } from "@/project-sidebar/contract.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { Clock, LoaderIcon, Moon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Badge } from "@/components/ui/badge.js";
import { TaskTitleOverflowText } from "@/components/TaskTitleOverflowText.js";
import { TaskInteractionBadge } from "@/TaskInteractionBadge.js";
import {
  TASK_GROUP_ROW_CLASS,
  TASK_GROUP_ROW_LINE_CLASS,
} from "@/project-sidebar/grouped/types.js";

interface TaskRowPreviewProps {
  dragOverlay?: boolean;
  isMobileActive: boolean;
  isActive: boolean;
  dragging?: boolean;
  canShowHoverActions: boolean;
  taskTitle: string;
  task: ZCodeTaskMeta;
  intl: IntlInstance;
  snoozeInteractionAutoResolution: (interactionId: string) => boolean | Promise<boolean>;
  taskAttentionDisplay: string | null;
  leadingIndicator: "error" | "unread" | "loading" | "none";
  statusDotClassName: string | null;
  hasPendingInteraction: boolean;
  isTaskCron: boolean;
  isTaskOffPeak: boolean;
  taskTimeLabel: string;
}

/**
 * 拖拽浮层里的 grouped task 行：DragOverlay 高频渲染时只渲染纯展示节点，
 * 不持有 state、不读取服务、不反向依赖父级。展示值与 handler 由 grouped/task-row.tsx 显式传入。
 */
export function TaskRowPreview({
  dragOverlay,
  isMobileActive,
  isActive,
  dragging,
  canShowHoverActions,
  taskTitle,
  task,
  intl,
  snoozeInteractionAutoResolution,
  taskAttentionDisplay,
  leadingIndicator,
  statusDotClassName,
  hasPendingInteraction,
  isTaskCron,
  isTaskOffPeak,
  taskTimeLabel,
}: TaskRowPreviewProps) {
  return (
    <div
      role={dragOverlay ? undefined : "button"}
      tabIndex={dragOverlay ? undefined : 0}
      data-mobile-active-task={!dragOverlay && isMobileActive ? "true" : undefined}
      className={cn(
        "group/task-row",
        TASK_GROUP_ROW_CLASS,
        dragOverlay
          ? "pointer-events-none cursor-grabbing border border-border bg-background shadow-lg opacity-100"
          : "cursor-pointer",
        isActive ? "bg-selected" : canShowHoverActions && "hover:bg-surface-hover",
        dragging && "opacity-0",
      )}
    >
      <span className={TASK_GROUP_ROW_LINE_CLASS}>
        <TaskTitleOverflowText
          as="span"
          className="text-foreground"
          title={dragOverlay ? undefined : taskTitle}
        >
          {/* Bugfix: grouped task 标题超出时不要显示省略号，右侧渐隐能保留标题连续性，避免和右侧状态元信息挤在一起。 */}
          {taskTitle}
        </TaskTitleOverflowText>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-ui-sm text-foreground-subtle">
          {task.pendingInteraction ? (
            <TaskInteractionBadge
              interaction={task.pendingInteraction}
              formatMessage={(id) => intl.formatMessage({ id })}
              onSnoozeCountdown={dragOverlay ? undefined : snoozeInteractionAutoResolution}
            />
          ) : taskAttentionDisplay ? (
            <Badge
              className={cn(
                "h-5 border-transparent bg-success/14 px-2 text-ui-base font-medium text-success dark:bg-success/18",
                canShowHoverActions && "group-hover/task-row:hidden",
              )}
            >
              {taskAttentionDisplay}
            </Badge>
          ) : null}
          <span
            className={cn(
              "flex shrink-0 items-center gap-1",
              canShowHoverActions && "group-hover/task-row:hidden",
            )}
          >
            {leadingIndicator === "loading" ? (
              <LoaderIcon className="size-3.5 animate-spin text-foreground-subtle" />
            ) : statusDotClassName ? (
              <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
                <span className={cn("size-1.5 rounded-full", statusDotClassName)} />
              </span>
            ) : null}
            {!hasPendingInteraction && isTaskCron ? (
              // drag overlay 也复用 grouped row 元信息；clock 放时间前面，不能跟未读点互斥。
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
        </span>
      </span>
    </div>
  );
}
