// Side Pane 完整视图的对话宿主（spec：docs/ui/side-pane-full-view.md）。
// 它包住 conversation-column 里唯一的 SessionPane 实例，只改变定位方式，不移动 DOM、不重挂载：
// - normal：静态布局，与原三栏一致；
// - conversation：fixed 铺满面板内容区（slot），对话全宽；
// - floating：fixed 浮在 slot 内的吸附位置，收起态只露出底部输入区。
// 几何值是 DOM 布局投影，直接写到宿主 style，不进入 React state，避免每次测量重渲染对话树。
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { ChevronDownIcon, ChevronUpIcon, LoaderIcon, MessageCircleIcon } from "lucide-react";
import { TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  clampFloatingPosition,
  dismissFloatingAnswerBubble,
  FLOATING_DRAG_CLICK_THRESHOLD_PX,
  FLOATING_MINIMIZED_SIZE_PX,
  rebaselineFloatingAnswerBubbles,
  reduceFloatingAnswerBubbles,
  resolveFloatingAnswerPreview,
  resolveFloatingExpandedHeight,
  resolveFloatingWidth,
  resolveNearestFloatingAnchor,
  type FloatingPosition,
  type FloatingRect,
} from "@/side-pane-full-view/model.js";
import type {
  ConversationPaneFloatingStatus,
  ConversationPanePresentationValue,
  FloatingAnchor,
  FloatingAnswerBubbleState,
  SidePaneFullViewFloating,
  SidePaneFullViewHostMode,
} from "@/side-pane-full-view/contract.js";
import { ConversationHostFrame } from "@/side-pane-full-view/ConversationHostFrame.js";
import {
  applyConversationHostGeometry,
  readSlotRect,
} from "@/side-pane-full-view/conversationHostGeometry.js";

const FLOATING_HEADER_HEIGHT_PX = 40;
/** 操作栏隐藏时抽屉藏在输入框后面的高度；聚焦时从这里向上滑出。 */
const DRAWER_TUCK_UNDER_COMPOSER_PX = 16;
const GEOMETRY_PROPERTIES = ["left", "top", "width", "height"] as const;
const GEOMETRY_VARIABLES = [
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
}

export function SidePaneFullViewConversationHost({
  mode,
  floating,
  anchor,
  slotElement,
  onFloatingChange,
  onAnchorChange,
  onOpenConversation,
  children,
}: {
  mode: SidePaneFullViewHostMode;
  floating: SidePaneFullViewFloating;
  anchor: FloatingAnchor;
  slotElement: HTMLElement | null;
  onFloatingChange: (floating: SidePaneFullViewFloating) => void;
  onAnchorChange: (anchor: FloatingAnchor) => void;
  onOpenConversation: () => void;
  children: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const isFloating = mode === "floating";
  const isMinimized = isFloating && floating === "minimized";
  const isExpanded = isFloating && floating === "expanded";
  const [status, setStatus] = useState<
    Pick<ConversationPaneFloatingStatus, "running" | "blockingInteractionId" | "ownerKey">
  >({
    running: false,
    blockingInteractionId: null,
    ownerKey: "",
  });
  /** 回答气泡按对话 owner 记录（只在内存里），只有点 × 或点气泡才清除。 */
  const [answerBubbles, setAnswerBubbles] = useState<
    ReadonlyMap<string, FloatingAnswerBubbleState>
  >(() => new Map());
  const [focusWithin, setFocusWithin] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const headerVisible =
    isFloating && !isMinimized && (isExpanded || focusWithin || menuOpen || dragging);
  const dockHeightRef = useRef(0);
  const dragRef = useRef<DragSession | null>(null);
  const dragPositionRef = useRef<FloatingPosition | null>(null);
  /** 上一次写入的几何是否为最小化形态；用来识别最小化与恢复之间的切换。 */
  const appliedMinimizedRef = useRef<boolean | null>(null);
  const applyGeometryRef = useRef<() => void>(() => {});

  const reportFloatingStatus = useCallback((next: ConversationPaneFloatingStatus) => {
    setStatus((current) =>
      current.running === next.running &&
      current.blockingInteractionId === next.blockingInteractionId &&
      current.ownerKey === next.ownerKey
        ? current
        : {
            running: next.running,
            blockingInteractionId: next.blockingInteractionId,
            ownerKey: next.ownerKey,
          },
    );
    setAnswerBubbles((current) => reduceFloatingAnswerBubbles(current, next));
  }, []);
  // 离开浮窗形态（对话 tab、退出完整视图）时清空基线：在对话 tab 里看过的回答，
  // 切回浮窗不再弹出；已经弹出的气泡保留。
  useEffect(() => {
    if (!isFloating) setAnswerBubbles(rebaselineFloatingAnswerBubbles);
  }, [isFloating]);
  const answer =
    isFloating && floating === "collapsed"
      ? (answerBubbles.get(status.ownerKey)?.answer ?? null)
      : null;
  const answerPreview = useMemo(
    () => (answer ? resolveFloatingAnswerPreview(answer.text) : ""),
    [answer],
  );
  const reportComposerDockHeight = useCallback((heightPx: number) => {
    if (dockHeightRef.current === heightPx) return;
    dockHeightRef.current = heightPx;
    applyGeometryRef.current();
  }, []);
  const presentationValue = useMemo<ConversationPanePresentationValue>(
    () => ({
      presentation: isFloating ? "floating" : "docked",
      reportFloatingStatus,
      reportComposerDockHeight,
    }),
    [isFloating, reportComposerDockHeight, reportFloatingStatus],
  );

  const resolveFrameSize = useCallback(
    (slot: FloatingRect) => {
      if (isMinimized) {
        return { width: FLOATING_MINIMIZED_SIZE_PX, height: FLOATING_MINIMIZED_SIZE_PX };
      }
      const paneHeight = Math.max(
        0,
        resolveFloatingExpandedHeight(slot.height) - FLOATING_HEADER_HEIGHT_PX,
      );
      const headerHeight = headerVisible ? FLOATING_HEADER_HEIGHT_PX : 0;
      // 收起态外层就是输入框本身；展开态输入层在抽屉内缩 1px，露出抽屉边框。
      const clipHeight = isExpanded
        ? Math.max(0, paneHeight - 1)
        : Math.min(dockHeightRef.current, paneHeight);
      const height = headerHeight + (isExpanded ? paneHeight : clipHeight);
      return {
        width: resolveFloatingWidth(slot.width),
        height,
        paneHeight: isExpanded ? clipHeight : paneHeight,
        clipHeight,
        // 修复原因：抽屉只伸到输入框后面 16px 时，抽屉底角与输入框顶角的圆角对出一个凹口。
        // 操作栏可见时抽屉一直延伸到浮窗底边，两侧边线连续，输入框像放在抽屉里。
        drawerHeight: headerVisible ? height : DRAWER_TUCK_UNDER_COMPOSER_PX,
      };
    },
    [headerVisible, isExpanded, isMinimized],
  );

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (mode === "normal" || !slotElement) {
      for (const property of GEOMETRY_PROPERTIES) host.style.removeProperty(property);
      for (const variable of GEOMETRY_VARIABLES) host.style.removeProperty(variable);
      applyGeometryRef.current = () => {};
      appliedMinimizedRef.current = null;
      return;
    }
    const apply = () => {
      applyConversationHostGeometry({
        host,
        slotElement,
        mode,
        anchor,
        isMinimized,
        resolveFrameSize,
        dragPositionRef,
        appliedMinimizedRef,
      });
    };
    applyGeometryRef.current = apply;
    apply();
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(apply);
    resizeObserver?.observe(slotElement);
    window.addEventListener("resize", apply);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", apply);
    };
  }, [anchor, isMinimized, mode, resolveFrameSize, slotElement]);

  // 最小化时出现新的阻塞交互（权限 / 问答）自动恢复为收起态，卡片替换输入框显示在浮窗内。
  // 只响应新的请求 id：用户在请求等待期间再次最小化，不会被同一个请求反复弹开。
  const seenBlockingInteractionIdRef = useRef(status.blockingInteractionId);
  useEffect(() => {
    const previous = seenBlockingInteractionIdRef.current;
    seenBlockingInteractionIdRef.current = status.blockingInteractionId;
    if (isMinimized && status.blockingInteractionId && status.blockingInteractionId !== previous) {
      onFloatingChange("collapsed");
    }
  }, [isMinimized, onFloatingChange, status.blockingInteractionId]);

  const focusComposer = useCallback(() => {
    window.requestAnimationFrame(() => {
      hostRef.current
        ?.querySelector<HTMLElement>(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`)
        ?.focus();
    });
  }, []);

  const handleFocusCapture = useCallback(() => setFocusWithin(true), []);
  const handleBlurCapture = useCallback((event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setFocusWithin(false);
  }, []);

  const beginDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const host = hostRef.current;
    if (!host) return;
    // 阻止 Radix 在 pointerdown 时打开菜单；是否打开由松手时是否发生拖动决定。
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = host.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: { left: rect.left, top: rect.top },
      moved: false,
    };
  }, []);
  const moveDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const session = dragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const dx = event.clientX - session.startX;
    const dy = event.clientY - session.startY;
    if (!session.moved && Math.hypot(dx, dy) < FLOATING_DRAG_CLICK_THRESHOLD_PX) return;
    if (!session.moved) {
      session.moved = true;
      setDragging(true);
    }
    dragPositionRef.current = { left: session.origin.left + dx, top: session.origin.top + dy };
    applyGeometryRef.current();
  }, []);
  const endDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>, onClick: () => void) => {
      const session = dragRef.current;
      if (!session || session.pointerId !== event.pointerId) return;
      dragRef.current = null;
      if (!session.moved) {
        onClick();
        return;
      }
      const host = hostRef.current;
      const dropped = dragPositionRef.current;
      dragPositionRef.current = null;
      setDragging(false);
      if (!host || !dropped || !slotElement) return;
      const slot = readSlotRect(slotElement);
      const rect = host.getBoundingClientRect();
      const nextAnchor = resolveNearestFloatingAnchor(
        clampFloatingPosition(dropped, slot, rect),
        slot,
        { width: rect.width, height: rect.height },
      );
      if (nextAnchor === anchor) {
        applyGeometryRef.current();
      } else {
        onAnchorChange(nextAnchor);
      }
    },
    [anchor, onAnchorChange, slotElement],
  );
  const cancelDrag = useCallback(() => {
    dragRef.current = null;
    dragPositionRef.current = null;
    setDragging(false);
    applyGeometryRef.current();
  }, []);

  const handleToggleExpanded = useCallback(() => {
    onFloatingChange(isExpanded ? "collapsed" : "expanded");
  }, [isExpanded, onFloatingChange]);
  const handleMinimize = useCallback(() => {
    setMenuOpen(false);
    onFloatingChange("minimized");
  }, [onFloatingChange]);
  const handleDismissAnswer = useCallback(() => {
    setAnswerBubbles((current) => dismissFloatingAnswerBubble(current, status.ownerKey));
  }, [status.ownerKey]);
  const handleOpenAnswer = useCallback(() => {
    handleDismissAnswer();
    onFloatingChange("expanded");
  }, [handleDismissAnswer, onFloatingChange]);
  const handleRestore = useCallback(() => {
    onFloatingChange("collapsed");
    focusComposer();
  }, [focusComposer, onFloatingChange]);

  const statusIcon = status.running ? (
    <LoaderIcon className="size-4 animate-spin text-foreground-subtle" aria-hidden="true" />
  ) : (
    <MessageCircleIcon className="size-4 text-foreground-subtle" aria-hidden="true" />
  );
  const statusLabel = intl.formatMessage({
    id: status.running ? "sidePane.fullView.statusRunning" : "sidePane.fullView.statusIdle",
  });
  const handleLabel = intl.formatMessage({ id: "sidePane.fullView.handle" });
  const expandLabel = intl.formatMessage({
    id: isExpanded ? "sidePane.fullView.collapseMessages" : "sidePane.fullView.expandMessages",
  });
  const ExpandIcon = isExpanded ? ChevronDownIcon : ChevronUpIcon;

  return (
    <ConversationHostFrame
      mode={mode}
      floating={floating}
      anchor={anchor}
      hostRef={hostRef}
      isFloating={isFloating}
      isMinimized={isMinimized}
      isExpanded={isExpanded}
      headerVisible={headerVisible}
      dragging={dragging}
      status={status}
      answer={answer}
      answerPreview={answerPreview}
      statusIcon={statusIcon}
      statusLabel={statusLabel}
      handleLabel={handleLabel}
      expandLabel={expandLabel}
      ExpandIcon={ExpandIcon}
      menuOpen={menuOpen}
      onMenuOpenChange={setMenuOpen}
      presentationValue={presentationValue}
      intl={intl}
      onOpenConversation={onOpenConversation}
      onFocusCapture={handleFocusCapture}
      onBlurCapture={handleBlurCapture}
      onOpenAnswer={handleOpenAnswer}
      onDismissAnswer={handleDismissAnswer}
      onMinimize={handleMinimize}
      onToggleExpanded={handleToggleExpanded}
      onRestore={handleRestore}
      onBeginDrag={beginDrag}
      onMoveDrag={moveDrag}
      onEndDrag={endDrag}
      onCancelDrag={cancelDrag}
    >
      {children}
    </ConversationHostFrame>
  );
}
