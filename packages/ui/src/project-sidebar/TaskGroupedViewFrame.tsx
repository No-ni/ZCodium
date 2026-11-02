import type { ContextType, Dispatch, RefObject, SetStateAction } from "react";
import { createPortal } from "react-dom";
import { DndContext, DragOverlay } from "@dnd-kit/core";
import { Hash, Maximize2, Minimize2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { TaskRenameDialog } from "@/TaskRenameDialog.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { ProjectTask, TaskGroupColor } from "@/project-sidebar/contract.js";
import type { ProjectTaskListContext } from "@/project-sidebar/ProjectTaskListContext.js";
import type { useProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { GroupedDraftTaskRow } from "@/project-sidebar/grouped/draft-task-row.js";
import { GROUPED_TASK_DROP_ANIMATION } from "@/project-sidebar/grouped/drag.js";
import { GroupDragOverlay } from "@/project-sidebar/grouped/group-drag-overlay.js";
import { GroupItem } from "@/project-sidebar/grouped/group-item.js";
import type { GroupItemProps } from "@/project-sidebar/grouped/GroupItemProps.js";
import { taskKey } from "@/project-sidebar/grouped/ids.js";
import { StickyGroupHeader } from "@/project-sidebar/grouped/sticky-group-header.js";
import { StickyGroupHeaderSlot } from "@/project-sidebar/grouped/sticky-group-header-slot.js";
import { GroupedTaskItem } from "@/project-sidebar/grouped/task-item.js";
import type { useGroupedDrag } from "@/project-sidebar/grouped/useGroupedDrag.js";
import { VirtualizedGroupedTopLevelList } from "@/project-sidebar/grouped/virtualized-top-level-list.js";
import type { ProjectTaskMutation } from "@/project-sidebar/task-mutation.js";

type GroupedDrag = ReturnType<typeof useGroupedDrag>;
type GroupedTaskNode = GroupedDrag["view"]["nodes"][number];

/**
 * 分组任务列表展示框：只消费 TaskGroupedView 给出的值与回调。
 * 草稿、拖拽、改名与分组命令仍在 TaskGroupedView，本组件不持有状态、不调用服务、不读取 context。
 */
export type TaskGroupedViewFrameProps = {
  toolbarTarget: HTMLElement | null;
  stickyTarget: HTMLElement | null;
  workspacePath: string;
  workspaceIdentity?: string;
  intl: IntlInstance;
  presentation: ContextType<typeof ProjectTaskListContext>;
  organization: ReturnType<typeof useProjectDirectory>["groups"];
  loading: boolean;
  drag: GroupedDrag;
  groups: Extract<GroupedTaskNode, { type: "group" }>["group"][];
  collapsed: Set<string>;
  changeCollapsed: Dispatch<SetStateAction<Set<string>>>;
  allExpanded: boolean;
  toggleLabel: string;
  toggleCollapsed: (id: string) => void;
  createTask: (groupId: string | null) => void;
  closeDraft: () => void;
  draftGroupId: string | null | undefined;
  activeTaskId: string | null;
  getWorkspaceLabel: (task: Pick<ProjectTask, "workspacePath" | "workspacePurpose">) => string;
  getTaskRemoteSessionId: (task: ProjectTask) => string | undefined;
  rowCallbacks: Pick<
    GroupItemProps,
    | "groups"
    | "onSelectTask"
    | "onCloseTask"
    | "onOpenFileTree"
    | "onMoveTaskToGroup"
    | "onMoveTaskToTop"
    | "onStartRenameTask"
    | "onArchiveTask"
    | "onMarkTaskAsUnread"
    | "tooltipsDisabled"
  >;
  rowSelection: (task: ProjectTask) => { isActive: boolean; isMobileActive: boolean };
  newGroupSetupId: string | null;
  setNewGroupSetupId: Dispatch<SetStateAction<string | null>>;
  updateColor: (id: string, color: TaskGroupColor) => void;
  ungroup: (id: string) => void;
  action: (work: () => Promise<unknown>, messageId?: string) => void;
  mutate: (task: ProjectTask, mutation: ProjectTaskMutation) => Promise<unknown>;
  sticky: GroupedTaskNode | undefined;
  activeTask: ProjectTask | null;
  activeGroup: GroupedTaskNode | undefined;
  overlayStyle: { width: string } | undefined;
  renamingTask: ProjectTask | null;
  renameDraft: string;
  renameInputRef: RefObject<HTMLInputElement | null>;
  setRenamingTask: Dispatch<SetStateAction<ProjectTask | null>>;
  setRenameDraft: Dispatch<SetStateAction<string>>;
};

export function TaskGroupedViewFrame({
  toolbarTarget,
  stickyTarget,
  workspacePath,
  workspaceIdentity,
  intl,
  presentation,
  organization,
  loading,
  drag,
  groups,
  collapsed,
  changeCollapsed,
  allExpanded,
  toggleLabel,
  toggleCollapsed,
  createTask,
  closeDraft,
  draftGroupId,
  activeTaskId,
  getWorkspaceLabel,
  getTaskRemoteSessionId,
  rowCallbacks,
  rowSelection,
  newGroupSetupId,
  setNewGroupSetupId,
  updateColor,
  ungroup,
  action,
  mutate,
  sticky,
  activeTask,
  activeGroup,
  overlayStyle,
  renamingTask,
  renameDraft,
  renameInputRef,
  setRenamingTask,
  setRenameDraft,
}: TaskGroupedViewFrameProps) {
  return (
    <>
      {toolbarTarget &&
        createPortal(
          <>
            <ControlHintTooltip title={toggleLabel}>
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0 text-foreground-subtle hover:text-foreground"
                aria-label={toggleLabel}
                data-testid="task-group-toggle-all"
                disabled={!groups.length}
                onClick={() =>
                  changeCollapsed(
                    allExpanded ? new Set(groups.map((group) => group.id)) : new Set(),
                  )
                }
              >
                {allExpanded ? (
                  <Minimize2 className="size-3.5" />
                ) : (
                  <Maximize2 className="size-3.5" />
                )}
              </Button>
            </ControlHintTooltip>
            <ControlHintTooltip title={intl.formatMessage({ id: "taskGroup.newGroup" })}>
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0 text-foreground-subtle hover:text-foreground"
                data-testid="task-group-add"
                aria-label={intl.formatMessage({ id: "taskGroup.newGroup" })}
                disabled={!organization.available}
                onClick={() =>
                  action(async () => {
                    const group = await organization.save({
                      title: intl.formatMessage({ id: "taskGroup.defaultTitle" }),
                    });
                    setNewGroupSetupId(group.id);
                  }, "taskGroup.createFailed")
                }
              >
                <Hash className="size-3.5" />
              </Button>
            </ControlHintTooltip>
          </>,
          toolbarTarget,
        )}
      {stickyTarget &&
        createPortal(
          <StickyGroupHeaderSlot
            header={
              sticky?.type === "group" ? (
                <StickyGroupHeader
                  node={sticky}
                  collapsed={collapsed.has(sticky.group.id)}
                  tooltipsDisabled={drag.dragging}
                  onCreateTask={() => createTask(sticky.group.id)}
                  onToggleCollapsed={toggleCollapsed}
                  onUpdateGroupColor={updateColor}
                  onUngroupGroup={ungroup}
                />
              ) : null
            }
          />,
          stickyTarget,
        )}
      <TaskRenameDialog
        open={renamingTask !== null}
        value={renameDraft}
        inputRef={renameInputRef}
        intl={intl}
        onOpenChange={(open) => {
          if (!open) setRenamingTask(null);
        }}
        onChange={setRenameDraft}
        onCancel={() => setRenamingTask(null)}
        onConfirm={() =>
          action(async () => {
            if (!renamingTask) return;
            await mutate(renamingTask, { kind: "rename", title: renameDraft.trim() });
            setRenamingTask(null);
          }, "taskList.renameFailed")
        }
      />
      <DndContext {...drag.dnd}>
        <div ref={drag.root} className="px-2 pb-4" data-testid="task-grouped-view">
          {draftGroupId === null && (
            <GroupedDraftTaskRow
              active={!activeTaskId}
              workspaceLabel={getWorkspaceLabel({ workspacePath })}
              onSelect={() => createTask(null)}
              onClose={closeDraft}
            />
          )}
          <VirtualizedGroupedTopLevelList
            nodes={drag.view.nodes}
            isGroupCollapsed={(id) => collapsed.has(id)}
            renderNode={(node) =>
              node.type === "group" ? (
                <div key={node.group.id} data-grouped-layout-key={`group:${node.group.id}`}>
                  <GroupItem
                    {...rowCallbacks}
                    activeWorkspacePath={workspacePath}
                    activeWorkspaceIdentity={workspaceIdentity}
                    activeTaskId={activeTaskId}
                    mobileActiveTaskKey={presentation.mobileActiveTaskKey}
                    node={node}
                    getTaskRemoteSessionId={getTaskRemoteSessionId}
                    getTaskWorkspaceLabel={getWorkspaceLabel}
                    onCreateTask={() => createTask(node.group.id)}
                    hasDraftTask={draftGroupId === node.group.id}
                    draftTaskActive={!activeTaskId}
                    draftWorkspaceLabel={getWorkspaceLabel({ workspacePath })}
                    onSelectDraftTask={() => createTask(node.group.id)}
                    onCloseDraftTask={closeDraft}
                    onRenameGroup={(id, title) =>
                      action(() => organization.save({ id, title }), "taskGroup.renameFailed")
                    }
                    onUpdateGroupColor={updateColor}
                    onUngroupGroup={ungroup}
                    newGroupSetup={newGroupSetupId === node.group.id}
                    onNewGroupSetupStarted={(id) =>
                      setNewGroupSetupId((current) => (current === id ? null : current))
                    }
                    collapsed={collapsed.has(node.group.id)}
                    onToggleCollapsed={toggleCollapsed}
                    activeDragTaskKey={drag.activeTaskKey}
                    activeDragGroupId={drag.activeGroupId}
                  />
                </div>
              ) : (
                <GroupedTaskItem
                  {...rowCallbacks}
                  key={taskKey(node.task)}
                  {...rowSelection(node.task)}
                  task={node.task}
                  remoteSessionId={getTaskRemoteSessionId(node.task)}
                  workspaceLabel={getWorkspaceLabel(node.task)}
                  dragId={taskKey(node.task)}
                  dragging={drag.activeTaskKey === taskKey(node.task)}
                />
              )
            }
          />
          {drag.view.nodes.length === 0 && draftGroupId === undefined && !loading && (
            <div className="px-3 py-2 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "taskList.noTasks" })}
            </div>
          )}
          {organization.error && (
            <p role="alert" className="px-3 text-ui-sm text-destructive">
              {organization.error}
            </p>
          )}
        </div>
        {createPortal(
          <DragOverlay dropAnimation={GROUPED_TASK_DROP_ANIMATION}>
            {activeTask ? (
              <div
                className="transition-[width,max-width] duration-150 ease-out motion-reduce:transition-none"
                style={overlayStyle}
              >
                <GroupedTaskItem
                  {...rowCallbacks}
                  {...rowSelection(activeTask)}
                  task={activeTask}
                  remoteSessionId={getTaskRemoteSessionId(activeTask)}
                  workspaceLabel={getWorkspaceLabel(activeTask)}
                  dragId={drag.activeTaskKey ?? undefined}
                  dragOverlay
                />
              </div>
            ) : activeGroup?.type === "group" ? (
              <GroupDragOverlay
                node={activeGroup}
                style={overlayStyle}
                className="transition-[width,max-width] duration-150 ease-out motion-reduce:transition-none"
              />
            ) : null}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>
    </>
  );
}
