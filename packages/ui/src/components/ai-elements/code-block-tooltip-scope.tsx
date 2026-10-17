import {
  cloneElement,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { composeRefs } from "@/lib/composeRefs.js";

type ButtonHintElement = ReactElement<
  ComponentProps<typeof Button> & { ref?: Ref<HTMLButtonElement> }
>;

interface ActiveHint {
  node: HTMLButtonElement;
  title: ReactNode;
  rect: { top: number; left: number; width: number; height: number };
}

interface CodeBlockTooltipScopeContext {
  pointerEnter: (node: HTMLButtonElement, title: ReactNode, pointerType: string) => void;
  pointerLeave: (node: HTMLButtonElement) => void;
  focus: (node: HTMLButtonElement, title: ReactNode) => void;
  blur: (node: HTMLButtonElement) => void;
  pointerDown: (node: HTMLButtonElement) => void;
  keyDown: (key: string) => void;
  detach: (node: HTMLButtonElement) => void;
}

const CodeBlockTooltipScopeContext = createContext<CodeBlockTooltipScopeContext | null>(null);

function addDescribedBy(node: HTMLElement, id: string) {
  const ids = (node.getAttribute("aria-describedby") ?? "").split(/\s+/u).filter(Boolean);
  if (!ids.includes(id)) {
    ids.push(id);
    node.setAttribute("aria-describedby", ids.join(" "));
  }
}

function removeDescribedBy(node: HTMLElement, id: string) {
  const ids = (node.getAttribute("aria-describedby") ?? "")
    .split(/\s+/u)
    .filter((existingId) => existingId && existingId !== id);
  if (ids.length > 0) {
    node.setAttribute("aria-describedby", ids.join(" "));
  } else {
    node.removeAttribute("aria-describedby");
  }
}

function readRect(node: HTMLElement): ActiveHint["rect"] {
  const rect = node.getBoundingClientRect();
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

function sameRect(left: ActiveHint["rect"], right: ActiveHint["rect"]): boolean {
  return (
    left.top === right.top &&
    left.left === right.left &&
    left.width === right.width &&
    left.height === right.height
  );
}

function isFocusVisible(node: HTMLElement): boolean {
  try {
    return node.matches(":focus-visible");
  } catch {
    return false;
  }
}

export function CodeBlockTooltipScope({ children }: { children: ReactNode }) {
  const anchorRef = useRef<HTMLElement | null>(null);
  const [activeHint, setActiveHint] = useState<ActiveHint | null>(null);
  const activeHintRef = useRef<ActiveHint | null>(null);
  const hoveredRef = useRef<ActiveHint | null>(null);
  const focusedRef = useRef<ActiveHint | null>(null);
  const dismissedNodeRef = useRef<HTMLButtonElement | null>(null);
  const suppressedFocusNodeRef = useRef<HTMLButtonElement | null>(null);

  const publishActiveHint = useCallback((next: ActiveHint | null) => {
    const previous = activeHintRef.current;
    if (previous?.node === next?.node && previous?.title === next?.title) return;
    activeHintRef.current = next;
    setActiveHint(next);
  }, []);

  const getAvailableFocus = useCallback(() => {
    const focused = focusedRef.current;
    return focused && focused.node.isConnected && suppressedFocusNodeRef.current !== focused.node
      ? focused
      : null;
  }, []);

  const dismiss = useCallback(() => {
    dismissedNodeRef.current = activeHintRef.current?.node ?? hoveredRef.current?.node ?? null;
    suppressedFocusNodeRef.current = focusedRef.current?.node ?? null;
    publishActiveHint(null);
  }, [publishActiveHint]);

  const pointerEnter = useCallback(
    (node: HTMLButtonElement, title: ReactNode, pointerType: string) => {
      if (pointerType === "touch" || !node.isConnected) return;
      const target: ActiveHint = { node, title, rect: readRect(node) };
      hoveredRef.current = target;
      publishActiveHint(target);
    },
    [publishActiveHint],
  );

  const pointerLeave = useCallback(
    (node: HTMLButtonElement) => {
      const wasHovered = hoveredRef.current?.node === node;
      const wasDismissed = dismissedNodeRef.current === node;
      if (!wasHovered && !wasDismissed) return;
      if (wasHovered) hoveredRef.current = null;
      if (wasDismissed) {
        // Escape 关闭的焦点提示由对应 blur 解锁，离开另一个 hover 目标不能把它重新打开。
        dismissedNodeRef.current = null;
      }
      if (activeHintRef.current?.node === node || wasDismissed) {
        publishActiveHint(getAvailableFocus());
      }
    },
    [getAvailableFocus, publishActiveHint],
  );

  const focus = useCallback(
    (node: HTMLButtonElement, title: ReactNode) => {
      if (!isFocusVisible(node) || !node.isConnected) return;
      suppressedFocusNodeRef.current = null;
      const target: ActiveHint = { node, title, rect: readRect(node) };
      focusedRef.current = target;
      publishActiveHint(target);
    },
    [publishActiveHint],
  );

  const blur = useCallback(
    (node: HTMLButtonElement) => {
      if (suppressedFocusNodeRef.current === node) suppressedFocusNodeRef.current = null;
      if (dismissedNodeRef.current === node) dismissedNodeRef.current = null;
      if (focusedRef.current?.node !== node) return;
      focusedRef.current = null;
      if (activeHintRef.current?.node === node) {
        const hovered = hoveredRef.current?.node.isConnected ? hoveredRef.current : null;
        publishActiveHint(hovered);
      }
    },
    [publishActiveHint],
  );

  const pointerDown = useCallback(
    (node: HTMLButtonElement) => {
      dismissedNodeRef.current = activeHintRef.current?.node ?? hoveredRef.current?.node ?? node;
      suppressedFocusNodeRef.current = focusedRef.current?.node ?? null;
      publishActiveHint(null);
    },
    [publishActiveHint],
  );

  const keyDown = useCallback(
    (key: string) => {
      if (key === "Escape") dismiss();
    },
    [dismiss],
  );

  const detach = useCallback(
    (node: HTMLButtonElement) => {
      if (hoveredRef.current?.node === node) hoveredRef.current = null;
      if (focusedRef.current?.node === node) focusedRef.current = null;
      if (dismissedNodeRef.current === node) dismissedNodeRef.current = null;
      if (suppressedFocusNodeRef.current === node) suppressedFocusNodeRef.current = null;
      if (activeHintRef.current?.node === node) publishActiveHint(null);
    },
    [publishActiveHint],
  );

  const handleTooltipOpenChange = useCallback(
    (open: boolean) => {
      if (!open) dismiss();
    },
    [dismiss],
  );

  const contextValue = useMemo<CodeBlockTooltipScopeContext>(
    () => ({ pointerEnter, pointerLeave, focus, blur, pointerDown, keyDown, detach }),
    [pointerEnter, pointerLeave, focus, blur, pointerDown, keyDown, detach],
  );

  useEffect(() => {
    if (!activeHint) return;
    const { node, rect } = activeHint;
    const ownerDocument = node.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    if (!ownerWindow) return;

    const closeForViewportChange = () => {
      if (activeHintRef.current?.node === node) dismiss();
    };
    ownerDocument.addEventListener("scroll", closeForViewportChange, {
      capture: true,
      passive: true,
    });
    ownerWindow.addEventListener("scroll", closeForViewportChange, {
      capture: true,
      passive: true,
    });
    ownerWindow.addEventListener("resize", closeForViewportChange, { passive: true });

    let frameId = 0;
    const checkTarget = () => {
      if (activeHintRef.current?.node !== node) return;
      if (!node.isConnected || !sameRect(readRect(node), rect)) {
        dismiss();
        return;
      }
      frameId = ownerWindow.requestAnimationFrame(checkTarget);
    };
    frameId = ownerWindow.requestAnimationFrame(checkTarget);

    return () => {
      ownerDocument.removeEventListener("scroll", closeForViewportChange, true);
      ownerWindow.removeEventListener("scroll", closeForViewportChange, true);
      ownerWindow.removeEventListener("resize", closeForViewportChange);
      ownerWindow.cancelAnimationFrame(frameId);
    };
  }, [activeHint, dismiss]);

  useLayoutEffect(() => {
    // Radix 的 role=tooltip 位于内部隐藏节点；复用 trigger 的实际 ID，避免描述指向外层浮层。
    const tooltipId = anchorRef.current?.getAttribute("aria-describedby");
    if (!activeHint || !tooltipId) return;
    const { node } = activeHint;
    addDescribedBy(node, tooltipId);
    return () => removeDescribedBy(node, tooltipId);
  }, [activeHint]);

  const portal = activeHint ? (
    <ControlHintTooltip
      triggerRef={anchorRef}
      open
      onOpenChange={handleTooltipOpenChange}
      side="top"
      title={activeHint.title}
    >
      <span
        aria-hidden="true"
        data-code-block-shared-hint-anchor
        tabIndex={-1}
        style={{
          position: "fixed",
          top: activeHint.rect.top,
          left: activeHint.rect.left,
          width: activeHint.rect.width,
          height: activeHint.rect.height,
          display: "block",
          opacity: 0,
          pointerEvents: "none",
        }}
      />
    </ControlHintTooltip>
  ) : null;

  return (
    <CodeBlockTooltipScopeContext.Provider value={contextValue}>
      {children}
      {activeHint ? createPortal(portal, activeHint.node.ownerDocument.body) : null}
    </CodeBlockTooltipScopeContext.Provider>
  );
}

export function CodeBlockControlHint({
  children,
  title,
}: {
  children: ButtonHintElement;
  title: ReactNode;
}) {
  const scope = useContext(CodeBlockTooltipScopeContext);
  const originalRef = children.props.ref;

  const scopeRef = useCallback(
    (node: HTMLButtonElement | null) => {
      if (node) return () => scope?.detach(node);
    },
    [scope],
  );
  const ref = useMemo(() => composeRefs(originalRef, scopeRef), [originalRef, scopeRef]);

  const onPointerEnter = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      children.props.onPointerEnter?.(event);
      if (!event.defaultPrevented) {
        scope?.pointerEnter(event.currentTarget, title, event.pointerType);
      }
    },
    [children.props.onPointerEnter, scope, title],
  );
  const onPointerLeave = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      children.props.onPointerLeave?.(event);
      scope?.pointerLeave(event.currentTarget);
    },
    [children.props.onPointerLeave, scope],
  );
  const onFocus = useCallback(
    (event: FocusEvent<HTMLButtonElement>) => {
      children.props.onFocus?.(event);
      if (!event.defaultPrevented) scope?.focus(event.currentTarget, title);
    },
    [children.props.onFocus, scope, title],
  );
  const onBlur = useCallback(
    (event: FocusEvent<HTMLButtonElement>) => {
      children.props.onBlur?.(event);
      scope?.blur(event.currentTarget);
    },
    [children.props.onBlur, scope],
  );
  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      children.props.onPointerDown?.(event);
      scope?.pointerDown(event.currentTarget);
    },
    [children.props.onPointerDown, scope],
  );
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      children.props.onKeyDown?.(event);
      scope?.keyDown(event.key);
    },
    [children.props.onKeyDown, scope],
  );

  if (!scope) {
    return (
      <ControlHintTooltip side="top" title={title}>
        {children}
      </ControlHintTooltip>
    );
  }

  // 原因：240 个围栏的复制/折行按钮会建立 480 个 Radix Tooltip Root；asChild trigger ref 变更会同步触发 Radix 状态更新，放大终态整树重挂。这里共用一个提示根，稳定转发 ref，attach 本身不写 React 状态。
  return cloneElement(children, {
    ref,
    onPointerEnter,
    onPointerLeave,
    onFocus,
    onBlur,
    onPointerDown,
    onKeyDown,
  });
}
