import type { KeyboardEvent, RefObject } from "react";
import { logger } from "@/logger.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";
export function focusGroupRename(
  titleInputRef: RefObject<HTMLInputElement | null>,
  groupTitle: string,
  options?: { select?: boolean },
) {
  const focus = () => {
    titleInputRef.current?.focus();
    if (options?.select) {
      if (titleInputRef.current?.value === groupTitle) titleInputRef.current.select();
    }
  };
  const animationFrame = window.requestAnimationFrame(focus);
  window.setTimeout(focus, 0);
  return () => window.cancelAnimationFrame(animationFrame);
}

export function handleGroupRenameKeyDown(
  event: KeyboardEvent<HTMLInputElement>,
  {
    renameCompositionActiveRef,
    groupId,
    commitRename,
    cancelRename,
  }: {
    renameCompositionActiveRef: RefObject<boolean>;
    groupId: string;
    commitRename: () => void;
    cancelRename: () => void;
  },
) {
  if (event.key === "Enter") {
    if (
      isImeComposingKeyEvent({
        compositionActive: renameCompositionActiveRef.current,
        nativeEvent: event.nativeEvent,
      })
    ) {
      // group 重命名里中文输入法用 Enter 确认候选词时也会冒出 keydown。
      // 这不是用户要提交重命名，不能 blur，否则 blur 会继续触发 commitRename。
      logger.debug("[WorkspaceGroupedTasksSection] ignore group rename enter during IME", {
        groupId: groupId,
      });
      return;
    }
    // 回归实测：显式 Enter 若只触发 blur，会被旧版菜单的焦点保护吞掉。
    // 直接提交用户意图，保留保护逻辑处理菜单自动抢焦和 IME 候选确认。
    event.preventDefault();
    event.stopPropagation();
    commitRename();
    return;
  }
  if (event.key === "Escape") {
    // group 标题编辑态按 Esc 只取消本次重命名，不能冒泡到外层弹层快捷键。
    event.preventDefault();
    event.stopPropagation();
    cancelRename();
  }
}

export function handleGroupRenameBlur({
  menuRenameFocusGuardRef,
  newGroupInitialFocusGuardRef,
  groupId,
  focusRenameInput,
  commitRename,
}: {
  menuRenameFocusGuardRef: RefObject<boolean>;
  newGroupInitialFocusGuardRef: RefObject<boolean>;
  groupId: string;
  focusRenameInput: (options?: { select?: boolean }) => unknown;
  commitRename: () => void;
}) {
  if (menuRenameFocusGuardRef.current) {
    // ContextMenu 的关闭动画和 focus restore 可能在 input 首次 focus 后继续触发 blur。
    // 这是菜单收尾阶段的焦点竞争，不代表用户结束重命名；保护窗口内保持编辑态并回焦。
    logger.debug("[WorkspaceGroupedTasksSection] keep group rename focus after context menu blur", {
      groupId: groupId,
    });
    focusRenameInput({ select: true });
    return;
  }
  if (newGroupInitialFocusGuardRef.current) {
    // 新建 group 会同时打开颜色菜单；Radix DropdownMenu 可能在打开瞬间抢焦，
    // 这个 blur 不代表用户结束命名，只在初始展开窗口内把焦点还给 name input。
    logger.debug("[WorkspaceGroupedTasksSection] keep new group initial name focus", {
      groupId: groupId,
    });
    focusRenameInput({ select: true });
    return;
  }
  commitRename();
}
