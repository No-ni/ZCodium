import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
} from "react";
import type {
  FloatingAnchor,
  FloatingPosition,
  FloatingRect,
  SidePaneFullViewFloating,
  SidePaneFullViewHostMode,
} from "../contract.js";
import {
  clampFloatingPosition,
  FLOATING_DRAG_CLICK_THRESHOLD_PX,
  FLOATING_MINIMIZED_SIZE_PX,
  resolveFloatingExpandedHeight,
  resolveFloatingPosition,
  resolveFloatingTransformOrigin,
  resolveFloatingWidth,
  resolveNearestFloatingAnchor,
} from "../domain/model.js";

const PROPERTIES = ["left", "top", "width", "height"] as const;
const VARIABLES = [
  "--side-pane-full-view-frame-width",
  "--side-pane-full-view-pane-height",
  "--side-pane-full-view-clip-height",
  "--side-pane-full-view-drawer-height",
] as const;
interface DragSession {
  pointerId: number;
  startX: number;
  startY: number;
  origin: FloatingPosition;
  moved: boolean;
  captureTarget: HTMLElement;
}
function releaseDragCapture(drag: DragSession | null) {
  if (drag?.captureTarget.hasPointerCapture?.(drag.pointerId))
    drag.captureTarget.releasePointerCapture(drag.pointerId);
}
function readRect(element: HTMLElement): FloatingRect {
  const { left, top, width, height } = element.getBoundingClientRect();
  return { left, top, width, height };
}

export function useFloatingGeometry({
  hostRef,
  slotElement,
  mode,
  floating,
  anchor,
  headerVisible,
  scopeKey,
  onAnchorChange,
}: {
  hostRef: RefObject<HTMLDivElement | null>;
  slotElement: HTMLElement | null;
  mode: SidePaneFullViewHostMode;
  floating: SidePaneFullViewFloating;
  anchor: FloatingAnchor;
  headerVisible: boolean;
  scopeKey: string;
  onAnchorChange: (anchor: FloatingAnchor) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<DragSession | null>(null);
  const dragPositionRef = useRef<FloatingPosition | null>(null);
  const dockHeightRef = useRef(0);
  const appliedMinimizedRef = useRef<boolean | null>(null);
  const applyRef = useRef<() => void>(() => {});
  const isMinimized = mode === "floating" && floating === "minimized";
  const isExpanded = mode === "floating" && floating === "expanded";
  const showHeader = headerVisible || (mode === "floating" && !isMinimized && dragging);
  const currentGeometryRef = useRef({ scopeKey, mode, slotElement });
  const previousGeometry = currentGeometryRef.current;
  if (
    previousGeometry.scopeKey !== scopeKey ||
    previousGeometry.mode !== mode ||
    previousGeometry.slotElement !== slotElement
  )
    dockHeightRef.current = 0;
  currentGeometryRef.current = { scopeKey, mode, slotElement };
  const reportComposerDockHeight = useCallback(
    (height: number) => {
      const current = currentGeometryRef.current;
      // Observer 可能在 owner/slot 换代后交付已排队测量；只能影响它创建时的浮窗。
      if (
        current.scopeKey !== scopeKey ||
        current.slotElement !== slotElement ||
        current.mode !== "floating"
      )
        return;
      if (!Number.isFinite(height) || height < 0 || dockHeightRef.current === height) return;
      dockHeightRef.current = height;
      applyRef.current();
    },
    [scopeKey, slotElement],
  );
  const cancelDrag = useCallback(() => {
    releaseDragCapture(dragRef.current);
    dragRef.current = null;
    dragPositionRef.current = null;
    setDragging(false);
    applyRef.current();
  }, []);
  useLayoutEffect(() => {
    cancelDrag();
    return () => {
      releaseDragCapture(dragRef.current);
      dragRef.current = null;
      dragPositionRef.current = null;
    };
  }, [cancelDrag, mode, scopeKey, slotElement]);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const clear = () => {
      for (const property of PROPERTIES) host.style.removeProperty(property);
      for (const variable of VARIABLES) host.style.removeProperty(variable);
      appliedMinimizedRef.current = null;
    };
    if (mode === "normal" || !slotElement) {
      clear();
      applyRef.current = () => {};
      return;
    }
    let disposed = false;
    const apply = () => {
      const current = currentGeometryRef.current;
      if (
        disposed ||
        current.scopeKey !== scopeKey ||
        current.mode !== mode ||
        current.slotElement !== slotElement
      )
        return;
      const slot = readRect(slotElement);
      if (mode === "conversation") {
        host.style.left = `${slot.left}px`;
        host.style.top = `${slot.top}px`;
        host.style.width = `${slot.width}px`;
        host.style.height = `${slot.height}px`;
        return;
      }
      const frameWidth = resolveFloatingWidth(slot.width);
      const paneHeight = Math.max(0, resolveFloatingExpandedHeight(slot.height) - 40);
      const clipHeight = isExpanded
        ? Math.max(0, paneHeight - 1)
        : Math.min(dockHeightRef.current, paneHeight);
      const height = (showHeader ? 40 : 0) + (isExpanded ? paneHeight : clipHeight);
      const size = isMinimized
        ? {
            width: Math.min(FLOATING_MINIMIZED_SIZE_PX, Math.max(0, slot.width)),
            height: Math.min(FLOATING_MINIMIZED_SIZE_PX, Math.max(0, slot.height)),
          }
        : { width: frameWidth, height };
      const crossing =
        appliedMinimizedRef.current !== null && appliedMinimizedRef.current !== isMinimized;
      appliedMinimizedRef.current = isMinimized;
      // 最小化时输入层仍按浮窗宽度排版，恢复不经过 48px 多行测量，防止高度先涨后落。
      if (crossing) host.style.transition = "none";
      host.style.setProperty(VARIABLES[0], `${frameWidth}px`);
      host.style.setProperty(VARIABLES[1], `${isExpanded ? clipHeight : paneHeight}px`);
      host.style.setProperty(VARIABLES[2], `${clipHeight}px`);
      host.style.setProperty(VARIABLES[3], `${showHeader ? height : 16}px`);
      const position = dragPositionRef.current
        ? clampFloatingPosition(dragPositionRef.current, slot, size)
        : resolveFloatingPosition(anchor, slot, size);
      host.style.left = `${position.left}px`;
      host.style.top = `${position.top}px`;
      host.style.width = `${size.width}px`;
      host.style.height = `${size.height}px`;
      if (crossing) {
        void host.offsetWidth;
        host.style.removeProperty("transition");
        host.style.transformOrigin = resolveFloatingTransformOrigin(anchor);
        if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
          host.animate?.(
            [
              { opacity: 0, transform: "scale(0.92)" },
              { opacity: 1, transform: "scale(1)" },
            ],
            { duration: 150, easing: "ease-out" },
          );
      }
    };
    applyRef.current = apply;
    apply();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(apply);
    observer?.observe(slotElement);
    window.addEventListener("resize", apply);
    window.addEventListener("scroll", apply, { capture: true, passive: true });
    return () => {
      disposed = true;
      observer?.disconnect();
      window.removeEventListener("resize", apply);
      window.removeEventListener("scroll", apply, true);
      applyRef.current = () => {};
    };
  }, [anchor, showHeader, hostRef, isExpanded, isMinimized, mode, scopeKey, slotElement]);
  const beginDrag = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const host = hostRef.current;
      if (event.button !== 0 || !host) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        origin: readRect(host),
        moved: false,
        captureTarget: event.currentTarget,
      };
    },
    [hostRef],
  );
  const moveDrag = useCallback((event: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < FLOATING_DRAG_CLICK_THRESHOLD_PX) return;
    if (!drag.moved) {
      drag.moved = true;
      setDragging(true);
    }
    dragPositionRef.current = { left: drag.origin.left + dx, top: drag.origin.top + dy };
    applyRef.current();
  }, []);
  const endDrag = useCallback(
    (event: PointerEvent<HTMLElement>, onClick: () => void) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      dragRef.current = null;
      releaseDragCapture(drag);
      if (!drag.moved) {
        onClick();
        return;
      }
      const host = hostRef.current;
      const position = dragPositionRef.current;
      dragPositionRef.current = null;
      setDragging(false);
      if (!host || !position || !slotElement) return;
      const slot = readRect(slotElement);
      const rect = readRect(host);
      const next = resolveNearestFloatingAnchor(
        clampFloatingPosition(position, slot, rect),
        slot,
        rect,
      );
      if (next === anchor) applyRef.current();
      else onAnchorChange(next);
    },
    [anchor, hostRef, onAnchorChange, slotElement],
  );
  return { dragging, beginDrag, moveDrag, endDrag, cancelDrag, reportComposerDockHeight };
}
