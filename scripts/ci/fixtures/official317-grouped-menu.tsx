import { useState } from "react";
import { createRoot } from "react-dom/client";
import { DndContext } from "@dnd-kit/core";
import { ZCodeIntlProvider, useZCodeIntl } from "../../../packages/ui/src/i18n/IntlProvider.js";
import { GroupItem } from "../../../packages/ui/src/project-sidebar/grouped/group-item.js";
import { TaskRowContent } from "../../../packages/ui/src/project-sidebar/grouped/TaskRowContent.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
} from "../../../packages/ui/src/components/ui/context-menu.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
} from "../../../packages/ui/src/components/ui/tooltip.js";
import "../../../packages/ui/src/styles.css";

const calls: unknown[] = [];
Object.assign(window, { fixtureCalls: calls });
const noop = () => {};
function Fixture() {
  const { intl } = useZCodeIntl();
  const [title, setTitle] = useState("Group A");
  const [collapsed, setCollapsed] = useState(true);
  const tooltipsDisabled = new URLSearchParams(location.search).has("no-tooltip");
  const row = (
    <TaskRowContent
      tooltipsDisabled={tooltipsDisabled}
      rowRef={noop}
      draggable={{
        attributes: {
          role: "button",
          tabIndex: 0,
          "aria-disabled": false,
          "aria-pressed": false,
          "aria-roledescription": "draggable",
          "aria-describedby": "fixture-dnd",
        },
        listeners: undefined,
      }}
      onSelect={noop}
      onKeyDown={noop}
      onRowMouseEnter={noop}
      onRowMouseLeave={noop}
      onRowContextMenu={noop}
      onRowFocusCapture={noop}
      onRowBlurCapture={noop}
      groupedTaskDomKey="fixture-row"
      task={{ taskId: "fixture-task" } as never}
      isMobileActive={false}
      isActive={false}
      taskTitle="Fixture task"
      intl={intl}
      snoozeInteractionAutoResolution={() => false}
      taskAttentionDisplay={null}
      shouldSuppressTaskMetadata={false}
      leadingIndicator="none"
      statusDotClassName={null}
      hasPendingInteraction={false}
      isTaskCron={false}
      isTaskOffPeak={false}
      taskTimeLabel=""
      shouldMountHoverActions={false}
      canOpenFileTree={false}
      workspaceActionsDisabledReason={undefined}
      onOpenFileTree={noop}
      onMoveTaskToTop={noop}
      onCloseTask={noop}
      workflowRunLinesNode={null}
    />
  );
  return (
    <main className="mx-auto max-w-lg p-4">
      <DndContext>
        <GroupItem
          node={{
            type: "group",
            group: { id: "fixture-group", title, color: "gray" } as never,
            tasks: [],
          }}
          groups={[]}
          activeWorkspacePath="/fixture-workspace"
          activeTaskId={null}
          getTaskRemoteSessionId={() => undefined}
          getTaskWorkspaceLabel={() => "Fixture"}
          onSelectTask={noop}
          onCloseTask={noop}
          onCreateTask={() => calls.push({ newTask: true })}
          onRenameGroup={(_id, value) => {
            calls.push({ title: value });
            setTitle(value);
          }}
          onUpdateGroupColor={noop}
          onUngroupGroup={noop}
          onMoveTaskToGroup={noop}
          onMoveTaskToTop={noop}
          onStartRenameTask={noop}
          onArchiveTask={noop}
          onMarkTaskAsUnread={noop}
          collapsed={collapsed}
          onToggleCollapsed={() => setCollapsed((value) => !value)}
          activeDragTaskKey={null}
          activeDragGroupId={null}
          tooltipsDisabled
        />
      </DndContext>
      <ContextMenu>
        {tooltipsDisabled ? (
          row
        ) : (
          <Tooltip>
            {row}
            <TooltipContent>Fixture tooltip</TooltipContent>
          </Tooltip>
        )}
        <ContextMenuContent>
          <ContextMenuItem
            data-testid="fixture-task-menu-action"
            onSelect={() => calls.push({ taskMenu: true })}
          >
            Fixture action
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale="en-US">
    <TooltipProvider>
      <Fixture />
    </TooltipProvider>
  </ZCodeIntlProvider>,
);
