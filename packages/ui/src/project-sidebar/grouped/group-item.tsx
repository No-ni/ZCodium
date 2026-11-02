import { GroupItemView } from "@/project-sidebar/grouped/GroupItemView.js";
import {
  focusGroupRename,
  handleGroupRenameKeyDown,
  handleGroupRenameBlur,
} from "@/project-sidebar/grouped/GroupRenameEvents.js";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";

import { CRON_DEFAULT_GROUP_ID, OFF_PEAK_DEFAULT_GROUP_ID } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { getTaskGroupDisplayTitle } from "@/project-sidebar/grouped/group-title.js";
import type { ZCodeTaskGroupColor } from "@/project-sidebar/grouped/types.js";
import type { GroupItemProps } from "@/project-sidebar/grouped/GroupItemProps.js";

export function GroupItem(props: GroupItemProps) {
  const {
    node,
    onRenameGroup,
    onUpdateGroupColor,
    newGroupSetup,
    onNewGroupSetupStarted,
    collapsed,
    onToggleCollapsed,
    activeDragGroupId,
    hasDraftTask,
  } = props;
  const { intl } = useZCodeIntl();
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(node.group.title);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const titleMeasureButtonRef = useRef<HTMLButtonElement | null>(null);
  const menuRenamePendingRef = useRef(false);
  const menuRenameFocusGuardRef = useRef(false);
  const menuRenameFocusGuardTimeoutRef = useRef<number | null>(null);
  const newGroupInitialFocusGuardRef = useRef(false);
  const newGroupInitialFocusGuardTimeoutRef = useRef<number | null>(null);
  const renameCompositionActiveRef = useRef(false);
  const [colorMenuOpen, setColorMenuOpen] = useState(false);
  const [titleEditorWidth, setTitleEditorWidth] = useState<number | null>(null);
  const groupContentId = useId();
  const [shouldRenderGroupContent, setShouldRenderGroupContent] = useState(() => !collapsed);
  const shouldShowEmptyDropZone = !hasDraftTask && node.tasks.length === 0;
  const visualCollapsed = collapsed;
  const titleEditorText = renameDraft || node.group.title;
  // 系统分组（cron / 闲时）：固定归类，禁止重命名与删除(解散)；颜色可改（与 cron 既有行为一致）。
  const isCronGroup = node.group.id === CRON_DEFAULT_GROUP_ID;
  const isOffPeakGroup = node.group.id === OFF_PEAK_DEFAULT_GROUP_ID;
  const isSystemGroup = isCronGroup || isOffPeakGroup;
  // 系统分组的标题按语言环境本地化展示，忽略 DB 里存的固定占位标题（'cron' / 'off-peak'）。
  const displayTitle = getTaskGroupDisplayTitle(node.group, {
    cron: intl.formatMessage({ id: "taskGroup.cronGroupName" }),
    offPeak: intl.formatMessage({ id: "offPeak.sidebar.groupTitle" }),
  });
  const dragging = activeDragGroupId === node.group.id;
  const groupDraggable = useDraggable({
    id: `group:${node.group.id}`,
    disabled: renaming,
    data: {
      type: "grouped-group",
      groupId: node.group.id,
    },
  });
  const groupOverDroppable = useDroppable({
    id: `group-over:${node.group.id}`,
    data: {
      type: "grouped-group-over",
      groupId: node.group.id,
    },
  });
  const collapsedGroupDroppable = useDroppable({
    id: `group-drop:${node.group.id}`,
    disabled: !visualCollapsed,
    data: {
      type: "grouped-collapsed-group",
      groupId: node.group.id,
    },
  });
  const expandedGroupHeaderDroppable = useDroppable({
    id: `group-header-drop:${node.group.id}`,
    disabled: visualCollapsed,
    data: {
      type: "grouped-expanded-group-header",
      groupId: node.group.id,
    },
  });
  const expandedGroupFooterDroppable = useDroppable({
    id: `group-footer-drop:${node.group.id}`,
    disabled: visualCollapsed,
    data: {
      type: "grouped-expanded-group-footer",
      groupId: node.group.id,
    },
  });
  const setGroupHeaderNodeRef = useCallback(
    (element: HTMLDivElement | null) => {
      groupDraggable.setNodeRef(element);
      expandedGroupHeaderDroppable.setNodeRef(element);
    },
    [expandedGroupHeaderDroppable.setNodeRef, groupDraggable.setNodeRef],
  );
  const setGroupItemNodeRef = useCallback(
    (element: HTMLDivElement | null) => {
      collapsedGroupDroppable.setNodeRef(element);
      groupOverDroppable.setNodeRef(element);
    },
    [collapsedGroupDroppable.setNodeRef, groupOverDroppable.setNodeRef],
  );
  useLayoutEffect(() => {
    if (!renaming) {
      setRenameDraft(node.group.title);
    }
  }, [node.group.title, renaming]);

  useLayoutEffect(() => {
    if (!renaming) {
      setTitleEditorWidth(null);
      return undefined;
    }
    const measureButton = titleMeasureButtonRef.current;
    if (!measureButton) {
      return undefined;
    }
    const updateWidth = () => {
      setTitleEditorWidth(Math.ceil(measureButton.getBoundingClientRect().width));
    };
    updateWidth();
    const resizeObserver = new ResizeObserver(updateWidth);
    resizeObserver.observe(measureButton);
    return () => resizeObserver.disconnect();
  }, [renaming, titleEditorText]);

  useLayoutEffect(() => {
    if (!renaming) {
      return undefined;
    }
    const animationFrame = window.requestAnimationFrame(() => {
      titleInputRef.current?.focus();
      if (titleInputRef.current?.value === node.group.title) titleInputRef.current.select();
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [renaming, node.group.title]);

  const focusRenameInput = useCallback(
    (options?: { select?: boolean }) => focusGroupRename(titleInputRef, node.group.title, options),
    [node.group.title],
  );

  const armMenuRenameFocusGuard = useCallback(() => {
    menuRenameFocusGuardRef.current = true;
    if (menuRenameFocusGuardTimeoutRef.current !== null) {
      window.clearTimeout(menuRenameFocusGuardTimeoutRef.current);
    }
    menuRenameFocusGuardTimeoutRef.current = window.setTimeout(() => {
      menuRenameFocusGuardRef.current = false;
      menuRenameFocusGuardTimeoutRef.current = null;
    }, 350);
  }, []);

  const armNewGroupInitialFocusGuard = useCallback(() => {
    newGroupInitialFocusGuardRef.current = true;
    if (newGroupInitialFocusGuardTimeoutRef.current !== null) {
      window.clearTimeout(newGroupInitialFocusGuardTimeoutRef.current);
    }
    newGroupInitialFocusGuardTimeoutRef.current = window.setTimeout(() => {
      newGroupInitialFocusGuardRef.current = false;
      newGroupInitialFocusGuardTimeoutRef.current = null;
    }, 350);
  }, []);

  const startRename = useCallback(() => {
    setRenameDraft(node.group.title);
    setRenaming(true);
  }, [node.group.title]);

  const startRenameFromMenu = useCallback(() => {
    menuRenamePendingRef.current = true;
  }, []);

  const consumePendingMenuRename = useCallback(() => {
    if (!menuRenamePendingRef.current) {
      return false;
    }
    menuRenamePendingRef.current = false;
    logger.debug("[WorkspaceGroupedTasksSection] context menu rename focus handoff", {
      groupId: node.group.id,
    });
    armMenuRenameFocusGuard();
    startRename();
    focusRenameInput({ select: true });
    return true;
  }, [armMenuRenameFocusGuard, focusRenameInput, node.group.id, startRename]);

  const handleContextMenuOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        window.setTimeout(consumePendingMenuRename, 0);
      }
    },
    [consumePendingMenuRename],
  );

  const handleContextMenuCloseAutoFocus = useCallback(
    (event: Event) => {
      // Radix context menu 关闭时会把焦点还给 trigger。
      // Rename 需要把焦点交给新出现的 input；这里先阻止默认 focus restore，再进入编辑态。
      if (consumePendingMenuRename()) {
        event.preventDefault();
      }
    },
    [consumePendingMenuRename],
  );

  const cancelRename = useCallback(() => {
    menuRenameFocusGuardRef.current = false;
    newGroupInitialFocusGuardRef.current = false;
    setRenameDraft(node.group.title);
    setRenaming(false);
  }, [node.group.title]);

  const commitRename = useCallback(() => {
    menuRenameFocusGuardRef.current = false;
    newGroupInitialFocusGuardRef.current = false;
    const nextTitle = renameDraft.trim() || node.group.title;
    setRenaming(false);
    if (nextTitle === node.group.title) {
      return;
    }
    onRenameGroup(node.group.id, nextTitle);
  }, [node.group.id, node.group.title, onRenameGroup, renameDraft]);

  const handleRenameKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) =>
      handleGroupRenameKeyDown(event, {
        renameCompositionActiveRef,
        groupId: node.group.id,
        commitRename,
        cancelRename,
      }),
    [cancelRename, commitRename, node.group.id],
  );

  const handleRenameBlur = useCallback(
    () =>
      handleGroupRenameBlur({
        menuRenameFocusGuardRef,
        newGroupInitialFocusGuardRef,
        groupId: node.group.id,
        focusRenameInput,
        commitRename,
      }),
    [commitRename, focusRenameInput, node.group.id],
  );

  useEffect(() => {
    return () => {
      if (menuRenameFocusGuardTimeoutRef.current !== null) {
        window.clearTimeout(menuRenameFocusGuardTimeoutRef.current);
      }
      if (newGroupInitialFocusGuardTimeoutRef.current !== null) {
        window.clearTimeout(newGroupInitialFocusGuardTimeoutRef.current);
      }
    };
  }, []);

  const handleColorMenuOpenChange = useCallback(
    (open: boolean) => {
      if (!open && newGroupInitialFocusGuardRef.current) {
        // 新建 group 同时要求 name input 保持焦点、color menu 自动展开。
        // Radix 在 input 回焦时会把这次初始展开判成外部焦点移动并请求关闭；
        // 只忽略初始窗口内的这一次关闭，窗口结束后点击空白仍按正常关闭处理。
        logger.debug("[WorkspaceGroupedTasksSection] keep new group initial color menu open", {
          groupId: node.group.id,
        });
        setColorMenuOpen(true);
        return;
      }
      setColorMenuOpen(open);
    },
    [node.group.id],
  );

  const handleGroupColorChange = useCallback(
    (color: string) => {
      onUpdateGroupColor(node.group.id, color as ZCodeTaskGroupColor);
    },
    [node.group.id, onUpdateGroupColor],
  );

  const handleHeaderClick = useCallback(() => {
    onToggleCollapsed(node.group.id);
  }, [node.group.id, onToggleCollapsed]);

  const handleHeaderKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.currentTarget !== event.target) {
        return;
      }
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      onToggleCollapsed(node.group.id);
    },
    [node.group.id, onToggleCollapsed],
  );

  useEffect(() => {
    if (!visualCollapsed) {
      setShouldRenderGroupContent(true);
      return undefined;
    }
    const timeout = window.setTimeout(() => {
      setShouldRenderGroupContent(false);
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [visualCollapsed]);

  useEffect(() => {
    if (!newGroupSetup) {
      return;
    }
    logger.debug("[WorkspaceGroupedTasksSection] start new group setup", {
      groupId: node.group.id,
    });
    armNewGroupInitialFocusGuard();
    startRename();
    setColorMenuOpen(true);
    focusRenameInput({ select: true });
    onNewGroupSetupStarted(node.group.id);
  }, [
    armNewGroupInitialFocusGuard,
    focusRenameInput,
    newGroupSetup,
    node.group.id,
    onNewGroupSetupStarted,
    startRename,
  ]);

  return (
    <GroupItemView
      props={props}
      headerProps={{
        headerRef: setGroupHeaderNodeRef,
        draggable: groupDraggable,
        visualCollapsed: visualCollapsed,
        renaming: renaming,
        dragging: dragging,
        groupContentId: groupContentId,
        colorMenuOpen: colorMenuOpen,
        onColorMenuOpenChange: handleColorMenuOpenChange,
        onColorChange: handleGroupColorChange,
        onHeaderClick: handleHeaderClick,
        onHeaderKeyDown: handleHeaderKeyDown,
        titleEditorWidth: titleEditorWidth,
        titleEditorText: titleEditorText,
        displayTitle: displayTitle,
        titleMeasureButtonRef: titleMeasureButtonRef,
        titleInputRef: titleInputRef,
        renameDraft: renameDraft,
        onRenameBlur: handleRenameBlur,
        onRenameDraftChange: (value) => setRenameDraft(value),
        onRenameCompositionEnd: () => {
          renameCompositionActiveRef.current = false;
        },
        onRenameCompositionStart: () => {
          renameCompositionActiveRef.current = true;
        },
        onRenameInputFocus: (event) => {
          // 菜单收尾的迟到回焦不能全选已输入内容，否则后续按键会覆盖名称前缀。
          if (event.currentTarget.value === node.group.title) event.currentTarget.select();
        },
        onRenameKeyDown: handleRenameKeyDown,
      }}
      contentProps={{
        groupContentId,
        visualCollapsed,
        shouldRenderGroupContent,
        shouldShowEmptyDropZone,
      }}
      setGroupItemNodeRef={setGroupItemNodeRef}
      footerRef={expandedGroupFooterDroppable.setNodeRef}
      isSystemGroup={isSystemGroup}
      handleContextMenuOpenChange={handleContextMenuOpenChange}
      startRenameFromMenu={startRenameFromMenu}
      handleGroupColorChange={handleGroupColorChange}
      handleContextMenuCloseAutoFocus={handleContextMenuCloseAutoFocus}
      intl={intl}
    />
  );
}
