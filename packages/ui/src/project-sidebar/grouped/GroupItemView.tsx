import type { RefCallback } from "react";
import { MessageCirclePlus } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { ContextMenu } from "@/components/ui/context-menu.js";
import { cn } from "@/components/lib/utils.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TASK_GROUP_CONTAINER_CLASS } from "@/project-sidebar/grouped/shared.js";
import { GroupItemHeader } from "@/project-sidebar/grouped/GroupItemHeader.js";
import { GroupItemContent } from "@/project-sidebar/grouped/GroupItemContent.js";
import { GroupItemContextMenu } from "@/project-sidebar/grouped/GroupItemContextMenu.js";
import type {
  GroupItemProps,
  GroupItemHeaderProps,
} from "@/project-sidebar/grouped/GroupItemProps.js";
export function GroupItemView({
  props,
  headerProps,
  contentProps,
  setGroupItemNodeRef,
  footerRef,
  isSystemGroup,
  handleContextMenuOpenChange,
  startRenameFromMenu,
  handleGroupColorChange,
  handleContextMenuCloseAutoFocus,
  intl,
}: {
  props: GroupItemProps;
  headerProps: Omit<GroupItemHeaderProps, "node" | "hasDraftTask" | "newTaskAction" | "intl">;
  contentProps: {
    groupContentId: string;
    visualCollapsed: boolean;
    shouldRenderGroupContent: boolean;
    shouldShowEmptyDropZone: boolean;
  };
  setGroupItemNodeRef: RefCallback<HTMLDivElement>;
  footerRef: RefCallback<HTMLDivElement>;
  isSystemGroup: boolean;
  handleContextMenuOpenChange: (open: boolean) => void;
  startRenameFromMenu: () => void;
  handleGroupColorChange: (color: string) => void;
  handleContextMenuCloseAutoFocus: (event: Event) => void;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
}) {
  const { node, hasDraftTask, tooltipsDisabled, onCreateTask, onUngroupGroup } = props;
  const visualCollapsed = contentProps.visualCollapsed;
  const expandedGroupFooterDroppable = { setNodeRef: footerRef };
  const newTaskButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="shrink-0 text-foreground-subtle hover:text-foreground"
      data-testid="task-group-new-task"
      aria-label={intl.formatMessage({ id: "taskGroup.newTask" })}
      onClick={(event) => {
        event.stopPropagation();
        onCreateTask();
      }}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
    >
      <MessageCirclePlus aria-hidden="true" className="size-3.5" />
    </Button>
  );
  const newTaskAction = tooltipsDisabled ? (
    newTaskButton
  ) : (
    <ControlHintTooltip title={intl.formatMessage({ id: "taskGroup.newTask" })}>
      {newTaskButton}
    </ControlHintTooltip>
  );

  return (
    <div
      ref={setGroupItemNodeRef}
      className={TASK_GROUP_CONTAINER_CLASS}
      data-grouped-group-item-id={node.group.id}
      data-task-group-id={node.group.id}
      data-task-group-title={node.group.title}
      data-group-collapsed={visualCollapsed ? "true" : "false"}
    >
      <ContextMenu onOpenChange={handleContextMenuOpenChange}>
        <GroupItemHeader
          {...headerProps}
          node={node}
          hasDraftTask={hasDraftTask}
          newTaskAction={newTaskAction}
          intl={intl}
        />
        <GroupItemContextMenu
          node={node}
          isSystemGroup={isSystemGroup}
          onCreateTask={onCreateTask}
          onStartRenameFromMenu={startRenameFromMenu}
          onColorChange={handleGroupColorChange}
          onUngroupGroup={onUngroupGroup}
          onCloseAutoFocus={handleContextMenuCloseAutoFocus}
          intl={intl}
        />
      </ContextMenu>
      <GroupItemContent {...props} {...contentProps} />
      <div
        ref={expandedGroupFooterDroppable.setNodeRef}
        aria-hidden="true"
        className={cn(
          "transition-[height,opacity] duration-150 ease-out motion-reduce:transition-none",
          visualCollapsed ? "h-0 pointer-events-none opacity-0" : "h-2.5 opacity-100",
        )}
      />
    </div>
  );
}
