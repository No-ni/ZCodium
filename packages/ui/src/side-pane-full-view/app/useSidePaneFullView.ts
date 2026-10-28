import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  SidePaneFullViewController,
  SidePaneFullViewFloating,
  SidePaneFullViewState,
  SidePaneFullViewSurface,
} from "../contract.js";
import { SIDE_PANE_FULL_VIEW_ENTER_STATE } from "../domain/model.js";
import {
  buildTaskSidePaneMemoryKey,
  peekTaskSidePaneFullView,
  saveTaskSidePaneFullView,
} from "@/lib/taskSidePaneMemory.js";

export function useSidePaneFullView({
  workspacePath,
  workspaceIdentity,
  ownerId,
  isSidePaneOpen,
  enabled,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  ownerId: string | null;
  isSidePaneOpen: boolean;
  enabled: boolean;
}): SidePaneFullViewController {
  const memoryKey = buildTaskSidePaneMemoryKey({
    workspacePath,
    workspaceIdentity,
    taskId: ownerId,
  });
  const scope = JSON.stringify([memoryKey, ownerId ?? "__draft__"]);
  const [snapshot, setSnapshot] = useState(() => ({
    scope,
    value: peekTaskSidePaneFullView(memoryKey, ownerId),
  }));
  const stored =
    snapshot.scope === scope ? snapshot.value : peekTaskSidePaneFullView(memoryKey, ownerId);
  const latestRef = useRef({ memoryKey, ownerId, scope, stored, enabled });
  latestRef.current = { memoryKey, ownerId, scope, stored, enabled };
  const write = useCallback((value: SidePaneFullViewState | null) => {
    const latest = latestRef.current;
    saveTaskSidePaneFullView(latest.memoryKey, latest.ownerId, value);
    latestRef.current = { ...latest, stored: value };
    setSnapshot({ scope: latest.scope, value });
  }, []);
  const previousRef = useRef({ scope, isSidePaneOpen });
  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = { scope, isSidePaneOpen };
    // 切 owner 的偏好恢复不是用户关闭，不能清掉被切走会话的完整视图记录。
    if (
      previous.scope === scope &&
      previous.isSidePaneOpen &&
      !isSidePaneOpen &&
      latestRef.current.stored
    )
      write(null);
  }, [isSidePaneOpen, scope, write]);
  const enter = useCallback(() => {
    if (latestRef.current.enabled && !latestRef.current.stored)
      write(SIDE_PANE_FULL_VIEW_ENTER_STATE);
  }, [write]);
  const exit = useCallback(() => {
    if (latestRef.current.stored) write(null);
  }, [write]);
  const toggle = useCallback(() => {
    if (!latestRef.current.enabled) return;
    write(latestRef.current.stored ? null : SIDE_PANE_FULL_VIEW_ENTER_STATE);
  }, [write]);
  const setSurface = useCallback(
    (surface: SidePaneFullViewSurface) => {
      const current = latestRef.current.stored;
      if (latestRef.current.enabled && current && current.surface !== surface)
        write({ ...current, surface });
    },
    [write],
  );
  const setFloating = useCallback(
    (floating: SidePaneFullViewFloating) => {
      const current = latestRef.current.stored;
      if (latestRef.current.enabled && current && current.floating !== floating)
        write({ ...current, floating });
    },
    [write],
  );
  const fullView = enabled && isSidePaneOpen ? stored : null;
  return useMemo(
    () => ({ fullView, enter, exit, toggle, setSurface, setFloating }),
    [fullView, enter, exit, toggle, setSurface, setFloating],
  );
}
