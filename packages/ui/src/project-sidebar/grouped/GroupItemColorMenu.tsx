import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import {
  TASK_GROUP_COLORS,
  TaskGroupColorDot,
  TaskGroupColorMark,
} from "@/project-sidebar/grouped/shared.js";
import type { GroupItemColorMenuProps } from "@/project-sidebar/grouped/GroupItemProps.js";

/**
 * 分组标题左侧的颜色入口：只渲染，不持有 state、不读取服务、不反向依赖父级。
 * 打开态与颜色选择命令由 grouped/group-item.tsx 显式传入，DOM、class、test-id 与事件顺序保持不变。
 */
export function GroupItemColorMenu({
  node,
  open,
  onOpenChange,
  onColorChange,
  intl,
}: GroupItemColorMenuProps) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex size-5 shrink-0 items-center justify-center rounded-full hover:bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-border-focused"
          data-testid="task-group-color-trigger"
          aria-label={intl.formatMessage({ id: "taskGroup.color" })}
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onTouchStart={(event) => event.stopPropagation()}
        >
          <TaskGroupColorMark color={node.group.color} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-40 min-w-40"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <DropdownMenuLabel>{intl.formatMessage({ id: "taskGroup.color" })}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={node.group.color} onValueChange={onColorChange}>
          {TASK_GROUP_COLORS.map((color) => (
            <DropdownMenuRadioItem
              key={color}
              value={color}
              data-testid={`task-group-color-${color}`}
            >
              <TaskGroupColorDot color={color} />
              <span>{intl.formatMessage({ id: `taskGroup.color.${color}` })}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
