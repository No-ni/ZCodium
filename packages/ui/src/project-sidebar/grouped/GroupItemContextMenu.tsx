import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu.js";
import { TASK_GROUP_COLORS, TaskGroupColorDot } from "@/project-sidebar/grouped/shared.js";
import type { GroupItemContextMenuProps } from "@/project-sidebar/grouped/GroupItemProps.js";

/**
 * 分组右键菜单内容：只渲染，不持有 state、不读取服务、不反向依赖父级。
 * 菜单开关、改名排队与颜色命令仍由 grouped/group-item.tsx 持有，DOM、class、test-id 与事件顺序保持不变。
 */
export function GroupItemContextMenu({
  node,
  isSystemGroup,
  onCreateTask,
  onStartRenameFromMenu,
  onColorChange,
  onUngroupGroup,
  onCloseAutoFocus,
  intl,
}: GroupItemContextMenuProps) {
  return (
    <ContextMenuContent className="w-44" onCloseAutoFocus={onCloseAutoFocus}>
      <ContextMenuItem onSelect={onCreateTask}>
        {intl.formatMessage({ id: "taskGroup.newTask" })}
      </ContextMenuItem>
      {isSystemGroup ? null : (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem data-testid="task-group-rename" onSelect={onStartRenameFromMenu}>
            {intl.formatMessage({ id: "taskGroup.renameAction" })}
          </ContextMenuItem>
        </>
      )}
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          {intl.formatMessage({ id: "taskGroup.changeColor" })}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent
          className="w-40"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {TASK_GROUP_COLORS.map((color) => (
            <ContextMenuItem key={color} onSelect={() => onColorChange(color)}>
              <TaskGroupColorDot color={color} />
              <span>{intl.formatMessage({ id: `taskGroup.color.${color}` })}</span>
            </ContextMenuItem>
          ))}
        </ContextMenuSubContent>
      </ContextMenuSub>
      {isSystemGroup ? null : (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            data-testid="task-group-ungroup"
            onSelect={() => onUngroupGroup(node.group.id)}
          >
            {intl.formatMessage({ id: "taskGroup.ungroup" })}
          </ContextMenuItem>
        </>
      )}
    </ContextMenuContent>
  );
}
