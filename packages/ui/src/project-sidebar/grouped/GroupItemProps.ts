import type { DraggableAttributes, DraggableSyntheticListeners } from "@dnd-kit/core";
import type { FocusEvent, KeyboardEvent, ReactNode, RefObject } from "react";
import type { ProjectTask as ZCodeTaskMeta } from "@/project-sidebar/contract.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type {
  ZCodeGroupedTaskViewNode,
  ZCodeTaskGroupColor,
} from "@/project-sidebar/grouped/types.js";
import type { TaskGroupMenuItem } from "@/project-sidebar/grouped/shared.js";

/**
 * 分组行与其展示子组件的显式 Props 契约：父组件 GroupItem 仍持有全部 hooks / ref / state /
 * 拖拽与改名 guard，只把展示值和 handler 显式传给纯展示组件，不反向 import 父级。
 */
export interface GroupItemProps {
  node: Extract<ZCodeGroupedTaskViewNode, { type: "group" }>;
  groups: TaskGroupMenuItem[];
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
  mobileActiveTaskKey?: string | null;
  getTaskRemoteSessionId: (task: ZCodeTaskMeta) => string | undefined;
  getTaskWorkspaceLabel: (task: ZCodeTaskMeta) => string;
  onSelectTask: (workspacePath: string, taskId: string, workspaceIdentity?: string) => void;
  onCloseTask: (task: ZCodeTaskMeta) => void;
  onOpenFileTree?: (task: ZCodeTaskMeta) => void;
  onCreateTask: () => void;
  hasDraftTask?: boolean;
  draftTaskActive?: boolean;
  draftWorkspaceLabel?: string;
  onSelectDraftTask?: () => void;
  onCloseDraftTask?: () => void;
  onRenameGroup: (groupId: string, title: string) => void;
  onUpdateGroupColor: (groupId: string, color: ZCodeTaskGroupColor) => void;
  onUngroupGroup: (groupId: string) => void;
  onMoveTaskToGroup: (task: ZCodeTaskMeta, groupId: string | null) => void;
  onMoveTaskToTop: (task: ZCodeTaskMeta) => void;
  onStartRenameTask: (task: ZCodeTaskMeta) => void;
  onArchiveTask: (task: ZCodeTaskMeta) => void;
  onMarkTaskAsUnread: (task: ZCodeTaskMeta) => void;
  newGroupSetup: boolean;
  onNewGroupSetupStarted: (groupId: string) => void;
  collapsed: boolean;
  onToggleCollapsed: (groupId: string) => void;
  activeDragTaskKey?: string | null;
  activeDragGroupId?: string | null;
  tooltipsDisabled?: boolean;
}

/** 标题左侧颜色入口的 Props。 */
export interface GroupItemColorMenuProps {
  node: Extract<ZCodeGroupedTaskViewNode, { type: "group" }>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onColorChange: (color: string) => void;
  intl: IntlInstance;
}

/** 右键菜单内容的 Props。 */
export interface GroupItemContextMenuProps {
  node: Extract<ZCodeGroupedTaskViewNode, { type: "group" }>;
  isSystemGroup: boolean;
  onCreateTask: () => void;
  onStartRenameFromMenu: () => void;
  onColorChange: (color: string) => void;
  onUngroupGroup: (groupId: string) => void;
  onCloseAutoFocus: (event: Event) => void;
  intl: IntlInstance;
}

/** 分组标题行（含颜色入口、标题/改名编辑器、计数与新建任务入口）的 Props。 */
export interface GroupItemHeaderProps {
  node: Extract<ZCodeGroupedTaskViewNode, { type: "group" }>;
  headerRef: (element: HTMLDivElement | null) => void;
  draggable: {
    attributes: DraggableAttributes;
    listeners: DraggableSyntheticListeners;
  };
  visualCollapsed: boolean;
  renaming: boolean;
  dragging: boolean;
  groupContentId: string;
  colorMenuOpen: boolean;
  onColorMenuOpenChange: (open: boolean) => void;
  onColorChange: (color: string) => void;
  onHeaderClick: () => void;
  onHeaderKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  titleEditorWidth: number | null;
  titleEditorText: string;
  displayTitle: string;
  titleMeasureButtonRef: RefObject<HTMLButtonElement | null>;
  titleInputRef: RefObject<HTMLInputElement | null>;
  renameDraft: string;
  onRenameBlur: () => void;
  onRenameDraftChange: (value: string) => void;
  onRenameCompositionEnd: () => void;
  onRenameCompositionStart: () => void;
  onRenameInputFocus: (event: FocusEvent<HTMLInputElement>) => void;
  onRenameKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  hasDraftTask?: boolean;
  newTaskAction: ReactNode;
  intl: IntlInstance;
}

/** 折叠容器内任务列表内容的 Props。 */
export interface GroupItemContentProps {
  node: Extract<ZCodeGroupedTaskViewNode, { type: "group" }>;
  groupContentId: string;
  visualCollapsed: boolean;
  shouldRenderGroupContent: boolean;
  shouldShowEmptyDropZone: boolean;
  hasDraftTask?: boolean;
  draftTaskActive?: boolean;
  draftWorkspaceLabel?: string;
  onSelectDraftTask?: () => void;
  onCloseDraftTask?: () => void;
  onCreateTask: () => void;
  groups: TaskGroupMenuItem[];
  getTaskRemoteSessionId: (task: ZCodeTaskMeta) => string | undefined;
  getTaskWorkspaceLabel: (task: ZCodeTaskMeta) => string;
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
  mobileActiveTaskKey?: string | null;
  onSelectTask: (workspacePath: string, taskId: string, workspaceIdentity?: string) => void;
  onCloseTask: (task: ZCodeTaskMeta) => void;
  onOpenFileTree?: (task: ZCodeTaskMeta) => void;
  onMoveTaskToGroup: (task: ZCodeTaskMeta, groupId: string | null) => void;
  onMoveTaskToTop: (task: ZCodeTaskMeta) => void;
  onStartRenameTask: (task: ZCodeTaskMeta) => void;
  onArchiveTask: (task: ZCodeTaskMeta) => void;
  onMarkTaskAsUnread: (task: ZCodeTaskMeta) => void;
  activeDragTaskKey?: string | null;
  tooltipsDisabled?: boolean;
}
