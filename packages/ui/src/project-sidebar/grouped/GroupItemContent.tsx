import { cn } from "@/components/lib/utils.js";
import { EmptyGroupDropZone } from "@/project-sidebar/grouped/task-item.js";
import { GroupedDraftTaskRow } from "@/project-sidebar/grouped/draft-task-row.js";
import { VirtualizedGroupedTaskList } from "@/project-sidebar/grouped/virtualized-group-task-list.js";
import {
  TASK_GROUP_BORDER_COLOR_CLASS,
  TASK_GROUP_CONTENT_CLASS,
} from "@/project-sidebar/grouped/shared.js";
import type { GroupItemContentProps } from "@/project-sidebar/grouped/GroupItemProps.js";

/**
 * 折叠容器内的分组任务列表：只渲染，不持有 state、不读取服务、不反向依赖父级。
 * 折叠态、卸载时机与任务命令全部由 grouped/group-item.tsx 显式传入，DOM、class、test-id 与事件顺序保持不变。
 */
export function GroupItemContent({
  node,
  groupContentId,
  visualCollapsed,
  shouldRenderGroupContent,
  shouldShowEmptyDropZone,
  hasDraftTask,
  draftTaskActive,
  draftWorkspaceLabel,
  onSelectDraftTask,
  onCloseDraftTask,
  onCreateTask,
  groups,
  getTaskRemoteSessionId,
  getTaskWorkspaceLabel,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  activeTaskId,
  mobileActiveTaskKey,
  onSelectTask,
  onCloseTask,
  onOpenFileTree,
  onMoveTaskToGroup,
  onMoveTaskToTop,
  onStartRenameTask,
  onArchiveTask,
  onMarkTaskAsUnread,
  activeDragTaskKey,
  tooltipsDisabled,
}: GroupItemContentProps) {
  return (
    <div
      id={groupContentId}
      data-grouped-group-content-id={node.group.id}
      aria-hidden={visualCollapsed}
      className={cn(
        "grid overflow-hidden",
        "transition-[grid-template-rows,opacity] duration-200 ease-out",
        visualCollapsed ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100",
      )}
    >
      <div className="min-h-0 overflow-hidden">
        {/* Bugfix: grouped task 的折叠内容不再走 Radix Collapsible。
              Radix Presence 和高度变量会在频繁挂载时重放动画；这里用本地受控容器，
              并在收起动画后卸载组内 task。 */}
        {shouldRenderGroupContent ? (
          <div
            className={cn(
              TASK_GROUP_CONTENT_CLASS,
              TASK_GROUP_BORDER_COLOR_CLASS[node.group.color],
            )}
          >
            {hasDraftTask ? (
              <>
                <GroupedDraftTaskRow
                  active={Boolean(draftTaskActive)}
                  workspaceLabel={draftWorkspaceLabel ?? ""}
                  onSelect={onSelectDraftTask ?? onCreateTask}
                  onClose={onCloseDraftTask}
                />
                <VirtualizedGroupedTaskList
                  tasks={node.tasks}
                  groupId={node.group.id}
                  groups={groups}
                  getTaskRemoteSessionId={getTaskRemoteSessionId}
                  getTaskWorkspaceLabel={getTaskWorkspaceLabel}
                  activeWorkspacePath={activeWorkspacePath}
                  activeWorkspaceIdentity={activeWorkspaceIdentity}
                  activeTaskId={activeTaskId}
                  mobileActiveTaskKey={mobileActiveTaskKey}
                  onSelectTask={onSelectTask}
                  onCloseTask={onCloseTask}
                  onOpenFileTree={onOpenFileTree}
                  onMoveTaskToGroup={onMoveTaskToGroup}
                  onMoveTaskToTop={onMoveTaskToTop}
                  onStartRenameTask={onStartRenameTask}
                  onArchiveTask={onArchiveTask}
                  onMarkTaskAsUnread={onMarkTaskAsUnread}
                  activeDragTaskKey={activeDragTaskKey}
                  tooltipsDisabled={tooltipsDisabled}
                />
              </>
            ) : (
              <>
                {shouldShowEmptyDropZone ? (
                  <EmptyGroupDropZone groupId={node.group.id} onCreateTask={onCreateTask} />
                ) : null}
                {node.tasks.length > 0 ? (
                  <VirtualizedGroupedTaskList
                    tasks={node.tasks}
                    groupId={node.group.id}
                    groups={groups}
                    getTaskRemoteSessionId={getTaskRemoteSessionId}
                    getTaskWorkspaceLabel={getTaskWorkspaceLabel}
                    activeWorkspacePath={activeWorkspacePath}
                    activeWorkspaceIdentity={activeWorkspaceIdentity}
                    activeTaskId={activeTaskId}
                    mobileActiveTaskKey={mobileActiveTaskKey}
                    onSelectTask={onSelectTask}
                    onCloseTask={onCloseTask}
                    onOpenFileTree={onOpenFileTree}
                    onMoveTaskToGroup={onMoveTaskToGroup}
                    onMoveTaskToTop={onMoveTaskToTop}
                    onStartRenameTask={onStartRenameTask}
                    onArchiveTask={onArchiveTask}
                    onMarkTaskAsUnread={onMarkTaskAsUnread}
                    activeDragTaskKey={activeDragTaskKey}
                    tooltipsDisabled={tooltipsDisabled}
                  />
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
