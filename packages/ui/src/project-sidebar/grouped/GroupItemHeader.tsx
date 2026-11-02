import { ContextMenuTrigger } from "@/components/ui/context-menu.js";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { SidebarNativeTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import {
  TASK_GROUP_COUNT_BADGE_CLASS,
  TASK_GROUP_HEADER_CLASS,
  TASK_GROUP_TITLE_CLASS,
} from "@/project-sidebar/grouped/shared.js";
import { GroupItemColorMenu } from "@/project-sidebar/grouped/GroupItemColorMenu.js";
import type { GroupItemHeaderProps } from "@/project-sidebar/grouped/GroupItemProps.js";

/**
 * 分组标题行：只渲染，不持有 state、不读取服务、不反向依赖父级。
 * 拖拽 attributes/listeners、ref、改名编辑态与 focus guard 全部由 grouped/group-item.tsx 显式传入，
 * DOM、class、test-id 与事件顺序保持不变。
 */
export function GroupItemHeader({
  node,
  headerRef,
  draggable,
  visualCollapsed,
  renaming,
  dragging,
  groupContentId,
  colorMenuOpen,
  onColorMenuOpenChange,
  onColorChange,
  onHeaderClick,
  onHeaderKeyDown,
  titleEditorWidth,
  titleEditorText,
  displayTitle,
  titleMeasureButtonRef,
  titleInputRef,
  renameDraft,
  onRenameBlur,
  onRenameDraftChange,
  onRenameCompositionEnd,
  onRenameCompositionStart,
  onRenameInputFocus,
  onRenameKeyDown,
  hasDraftTask,
  newTaskAction,
  intl,
}: GroupItemHeaderProps) {
  return (
    <ContextMenuTrigger asChild>
      <div
        ref={headerRef}
        {...draggable.attributes}
        {...draggable.listeners}
        // 改名仅暂停拖拽；容器不可用会让内部输入框也继承禁用语义。
        aria-disabled={undefined}
        data-grouped-group-header-id={node.group.id}
        data-testid="task-group-menu"
        role="button"
        tabIndex={0}
        aria-controls={groupContentId}
        aria-expanded={!visualCollapsed}
        className={cn(
          TASK_GROUP_HEADER_CLASS,
          renaming ? "cursor-default" : "cursor-pointer",
          dragging && "opacity-0",
        )}
        onClick={onHeaderClick}
        onKeyDown={onHeaderKeyDown}
      >
        <GroupItemColorMenu
          node={node}
          intl={intl}
          open={colorMenuOpen}
          onOpenChange={onColorMenuOpenChange}
          onColorChange={onColorChange}
        />
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {renaming ? (
            <label
              className="relative min-w-6 max-w-full shrink overflow-hidden align-middle"
              onClick={(event) => event.stopPropagation()}
              style={titleEditorWidth ? { width: `${titleEditorWidth}px` } : undefined}
            >
              <span className="sr-only">{intl.formatMessage({ id: "taskGroup.rename" })}</span>
              <button
                ref={titleMeasureButtonRef}
                type="button"
                tabIndex={-1}
                aria-hidden="true"
                className="pointer-events-none absolute left-0 top-0 invisible overflow-hidden rounded-sm px-1 text-left text-ui-base text-foreground"
                // 测量节点不能跟随 label 的 max-w-full，否则输入变长时会被当前宽度反向卡住。
                // 外层 label 继续用 max-w-full 负责视觉裁剪，这里只测真实内容宽度。
                style={{ whiteSpace: "pre" }}
              >
                {titleEditorText}
              </button>
              <input
                data-testid="task-group-title-input"
                ref={titleInputRef}
                autoFocus
                className="w-full min-w-0 truncate rounded-sm border-0 bg-transparent px-1 py-0 text-left text-ui-base leading-normal text-foreground outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-input-border-focused"
                value={renameDraft}
                onBlur={onRenameBlur}
                onChange={(event) => onRenameDraftChange(event.target.value)}
                onCompositionEnd={onRenameCompositionEnd}
                onCompositionStart={onRenameCompositionStart}
                onFocus={onRenameInputFocus}
                onKeyDown={onRenameKeyDown}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                onTouchStart={(event) => event.stopPropagation()}
                placeholder={node.group.title}
              />
            </label>
          ) : (
            <SidebarNativeTooltip>
              <button
                type="button"
                className={TASK_GROUP_TITLE_CLASS}
                title={displayTitle}
                aria-label={displayTitle}
              >
                {displayTitle}
              </button>
            </SidebarNativeTooltip>
          )}
          {visualCollapsed ? (
            <ChevronRightIcon
              aria-hidden="true"
              className="size-3.5 shrink-0 text-foreground-subtlest"
            />
          ) : (
            <ChevronDownIcon
              aria-hidden="true"
              className="size-3.5 shrink-0 text-foreground-subtlest"
            />
          )}
        </div>
        <span className={TASK_GROUP_COUNT_BADGE_CLASS}>
          {node.tasks.length + (hasDraftTask ? 1 : 0)}
        </span>
        {newTaskAction}
      </div>
    </ContextMenuTrigger>
  );
}
