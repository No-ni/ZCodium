import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
} from "react";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  GripVerticalIcon,
  LoaderIcon,
  Maximize2Icon,
  MessageCircleIcon,
  MinusIcon,
} from "lucide-react";
import {
  TID_SIDE_PANE_FULL_VIEW_BUBBLE,
  TID_SIDE_PANE_FULL_VIEW_DRAWER,
  TID_SIDE_PANE_FULL_VIEW_EXPAND,
  TID_SIDE_PANE_FULL_VIEW_HANDLE,
  TID_SIDE_PANE_FULL_VIEW_HEADER,
  TID_SIDE_PANE_FULL_VIEW_HOST,
  TID_SIDE_PANE_FULL_VIEW_MENU_MINIMIZE,
  TID_SIDE_PANE_FULL_VIEW_MENU_OPEN_CONVERSATION,
  TID_SIDE_PANE_FULL_VIEW_MINIMIZE,
  TID_SIDE_PANE_FULL_VIEW_RUNNING,
  TID_V4_COMPOSER_INPUT,
} from "@zcode/shared";
import type {
  ConversationPaneFloatingStatus,
  ConversationPanePresentationValue,
  FloatingAnchor,
  FloatingAnswerBubbleState,
  SidePaneFullViewFloating,
  SidePaneFullViewHostMode,
} from "../contract.js";
import {
  dismissFloatingAnswerBubble,
  rebaselineFloatingAnswerBubbles,
  reduceFloatingAnswerBubbles,
} from "../domain/model.js";
import { ConversationPanePresentationContext } from "../app/conversationPanePresentation.js";
import { useFloatingGeometry } from "../adapters/useFloatingGeometry.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { FloatingAnswerBubble } from "./FloatingAnswerBubble.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const EMPTY_STATUS: ConversationPaneFloatingStatus = {
  running: false,
  blockingInteractionId: null,
  ownerKey: "",
  latestTurn: null,
};
export function SidePaneFullViewConversationHost({
  mode,
  floating,
  anchor,
  scopeKey,
  slotElement,
  onFloatingChange,
  onAnchorChange,
  onOpenConversation,
  children,
}: {
  mode: SidePaneFullViewHostMode;
  floating: SidePaneFullViewFloating;
  anchor: FloatingAnchor;
  scopeKey: string;
  slotElement: HTMLElement | null;
  onFloatingChange: (floating: SidePaneFullViewFloating) => void;
  onAnchorChange: (anchor: FloatingAnchor) => void;
  onOpenConversation: () => void;
  children: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const hostRef = useRef<HTMLDivElement>(null);
  const currentScopeRef = useRef(scopeKey);
  currentScopeRef.current = scopeKey;
  const isFloating = mode === "floating";
  const isMinimized = isFloating && floating === "minimized";
  const isExpanded = isFloating && floating === "expanded";
  const [reported, setReported] = useState({ scopeKey, status: EMPTY_STATUS });
  const status = reported.scopeKey === scopeKey ? reported.status : EMPTY_STATUS;
  const [answerBubbles, setAnswerBubbles] = useState<
    ReadonlyMap<string, FloatingAnswerBubbleState>
  >(() => new Map());
  const [focusWithin, setFocusWithin] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const baseHeaderVisible = isFloating && !isMinimized && (isExpanded || focusWithin || menuOpen);
  const geometry = useFloatingGeometry({
    hostRef,
    slotElement,
    mode,
    floating,
    anchor,
    headerVisible: baseHeaderVisible,
    scopeKey,
    onAnchorChange,
  });
  const headerVisible = baseHeaderVisible || (isFloating && !isMinimized && geometry.dragging);
  const currentModeRef = useRef(mode);
  currentModeRef.current = mode;
  const reportFloatingStatus = useCallback(
    (next: ConversationPaneFloatingStatus) => {
      if (currentScopeRef.current !== scopeKey || currentModeRef.current !== "floating") return;
      setReported((current) =>
        current.scopeKey === scopeKey &&
        current.status.running === next.running &&
        current.status.blockingInteractionId === next.blockingInteractionId &&
        current.status.ownerKey === next.ownerKey
          ? current
          : { scopeKey, status: next },
      );
      setAnswerBubbles((current) => reduceFloatingAnswerBubbles(current, next));
    },
    [scopeKey],
  );
  const presentation = useMemo<ConversationPanePresentationValue>(
    () => ({
      presentation: isFloating ? "floating" : "docked",
      reportFloatingStatus,
      reportComposerDockHeight: geometry.reportComposerDockHeight,
    }),
    [isFloating, reportFloatingStatus, geometry.reportComposerDockHeight],
  );
  useEffect(() => {
    if (!isFloating) setAnswerBubbles(rebaselineFloatingAnswerBubbles);
  }, [isFloating]);
  useEffect(() => {
    setFocusWithin(false);
    setMenuOpen(false);
  }, [scopeKey, mode]);
  const seenBlockingRef = useRef({ ownerKey: "", interactionId: null as string | null });
  useEffect(() => {
    const previous = seenBlockingRef.current;
    seenBlockingRef.current = {
      ownerKey: status.ownerKey,
      interactionId: status.blockingInteractionId,
    };
    if (
      isMinimized &&
      status.blockingInteractionId &&
      (previous.ownerKey !== status.ownerKey ||
        previous.interactionId !== status.blockingInteractionId)
    )
      onFloatingChange("collapsed");
  }, [isMinimized, onFloatingChange, status.ownerKey, status.blockingInteractionId]);
  const focusFrameRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (focusFrameRef.current !== null) window.cancelAnimationFrame(focusFrameRef.current);
    },
    [scopeKey, mode],
  );
  const focusComposer = useCallback(() => {
    if (focusFrameRef.current !== null) window.cancelAnimationFrame(focusFrameRef.current);
    const scope = scopeKey;
    focusFrameRef.current = window.requestAnimationFrame(() => {
      focusFrameRef.current = null;
      if (currentScopeRef.current !== scope || currentModeRef.current !== "floating") return;
      const host = hostRef.current;
      if (!host) return;
      // 组合选择器按 DOM 顺序命中隐藏 pane；先限定 focused owner，不能退到另一个 pane 的输入。
      const pane = host.querySelector<HTMLElement>('[data-focused="true"]');
      const target = pane ?? (host.querySelector("[data-focused]") ? null : host);
      target?.querySelector<HTMLElement>(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`)?.focus();
    });
  }, [scopeKey]);
  const handleBlur = useCallback((event: FocusEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))
      return;
    setFocusWithin(false);
  }, []);
  const handleMinimize = useCallback(() => {
    setMenuOpen(false);
    onFloatingChange("minimized");
  }, [onFloatingChange]);
  const handleRestore = useCallback(() => {
    onFloatingChange("collapsed");
    focusComposer();
  }, [focusComposer, onFloatingChange]);
  const dismissAnswer = useCallback(
    () => setAnswerBubbles((current) => dismissFloatingAnswerBubble(current, status.ownerKey)),
    [status.ownerKey],
  );
  const answer =
    isFloating && floating === "collapsed" ? answerBubbles.get(status.ownerKey)?.answer : null;
  const statusLabel = intl.formatMessage({
    id: status.running ? "sidePane.fullView.statusRunning" : "sidePane.fullView.statusIdle",
  });
  const expandLabel = intl.formatMessage({
    id: isExpanded ? "sidePane.fullView.collapseMessages" : "sidePane.fullView.expandMessages",
  });
  const handleLabel = intl.formatMessage({ id: "sidePane.fullView.handle" });
  const ExpandIcon = isExpanded ? ChevronDownIcon : ChevronUpIcon;
  return (
    <div
      ref={hostRef}
      data-testid={TID_SIDE_PANE_FULL_VIEW_HOST}
      data-side-pane-full-view-host={mode}
      data-floating={isFloating ? floating : undefined}
      data-header-visible={headerVisible ? "true" : "false"}
      data-dragging={geometry.dragging ? "true" : undefined}
      data-running={status.running ? "true" : "false"}
      onFocusCapture={isFloating ? () => setFocusWithin(true) : undefined}
      onBlurCapture={isFloating ? handleBlur : undefined}
      className={cn(
        mode === "normal" && "relative h-full w-full",
        mode === "conversation" && "fixed z-30 flex flex-col",
        isFloating &&
          "fixed z-30 transition-[left,top,width,height] duration-150 ease-out data-[dragging=true]:transition-none motion-reduce:transition-none",
      )}
    >
      <ConversationPanePresentationContext.Provider value={presentation}>
        {answer ? (
          <FloatingAnswerBubble
            anchor={anchor}
            text={answer.text}
            onDismiss={dismissAnswer}
            onOpen={() => {
              dismissAnswer();
              onFloatingChange("expanded");
            }}
          />
        ) : null}
        {isFloating && !isMinimized ? (
          <div
            data-testid={TID_SIDE_PANE_FULL_VIEW_DRAWER}
            data-open={headerVisible ? "true" : "false"}
            className={cn(
              "absolute inset-x-0 top-0 h-[var(--side-pane-full-view-drawer-height)] overflow-hidden rounded-xl border border-border bg-popover shadow-lg transition-[height,opacity] duration-150 ease-out motion-reduce:transition-none",
              headerVisible ? "opacity-100" : "pointer-events-none opacity-0",
            )}
          >
            {headerVisible ? (
              <div
                data-testid={TID_SIDE_PANE_FULL_VIEW_HEADER}
                data-expanded={isExpanded ? "true" : "false"}
                className="flex h-10 items-center gap-1 px-2"
                onMouseDown={(event) => event.preventDefault()}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  data-testid={TID_SIDE_PANE_FULL_VIEW_MINIMIZE}
                  aria-label={intl.formatMessage({ id: "sidePane.fullView.minimize" })}
                  onClick={handleMinimize}
                >
                  <MinusIcon className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  data-testid={TID_SIDE_PANE_FULL_VIEW_EXPAND}
                  aria-label={expandLabel}
                  aria-expanded={isExpanded}
                  onClick={() => onFloatingChange(isExpanded ? "collapsed" : "expanded")}
                >
                  <ExpandIcon className="size-4" />
                </Button>
                {status.running ? (
                  <span
                    role="status"
                    data-testid={TID_SIDE_PANE_FULL_VIEW_RUNNING}
                    aria-label={statusLabel}
                    className="flex size-6 items-center justify-center"
                  >
                    <LoaderIcon
                      className="size-4 animate-spin text-foreground-subtle"
                      aria-hidden="true"
                    />
                  </span>
                ) : null}
                <div className="min-w-0 flex-1" />
                <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
                  <ControlHintTooltip title={handleLabel} side="top" align="end">
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        data-testid={TID_SIDE_PANE_FULL_VIEW_HANDLE}
                        aria-label={handleLabel}
                        className="cursor-grab touch-none"
                        onPointerDown={geometry.beginDrag}
                        onPointerMove={geometry.moveDrag}
                        onPointerUp={(event) => geometry.endDrag(event, () => setMenuOpen(true))}
                        onPointerCancel={geometry.cancelDrag}
                      >
                        <GripVerticalIcon className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                  </ControlHintTooltip>
                  <DropdownMenuContent align="end" side="top" className="w-52">
                    <DropdownMenuItem
                      data-testid={TID_SIDE_PANE_FULL_VIEW_MENU_OPEN_CONVERSATION}
                      onSelect={() => {
                        setMenuOpen(false);
                        onOpenConversation();
                      }}
                    >
                      <Maximize2Icon className="size-4" />
                      {intl.formatMessage({ id: "sidePane.fullView.openConversation" })}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      data-testid={TID_SIDE_PANE_FULL_VIEW_MENU_MINIMIZE}
                      onSelect={handleMinimize}
                    >
                      <MinusIcon className="size-4" />
                      {intl.formatMessage({ id: "sidePane.fullView.minimize" })}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ) : null}
          </div>
        ) : null}
        {isMinimized ? (
          <button
            type="button"
            data-testid={TID_SIDE_PANE_FULL_VIEW_BUBBLE}
            aria-label={intl.formatMessage({ id: "sidePane.fullView.restore" })}
            title={statusLabel}
            className="absolute inset-0 z-10 flex cursor-grab touch-none items-center justify-center rounded-full border border-border bg-popover shadow-lg hover:bg-hover"
            onPointerDown={geometry.beginDrag}
            onPointerMove={geometry.moveDrag}
            onPointerUp={(event) => geometry.endDrag(event, handleRestore)}
            onPointerCancel={geometry.cancelDrag}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                handleRestore();
              }
            }}
          >
            {status.running ? (
              <LoaderIcon
                className="size-4 animate-spin text-foreground-subtle"
                aria-hidden="true"
              />
            ) : (
              <MessageCircleIcon className="size-4 text-foreground-subtle" aria-hidden="true" />
            )}
          </button>
        ) : null}
        <div
          data-side-pane-full-view-clip=""
          className={cn(
            "relative min-h-0",
            mode === "normal" && "h-full",
            mode === "conversation" && "flex-1",
            isFloating &&
              "absolute z-10 h-[var(--side-pane-full-view-clip-height)] overflow-hidden",
            isFloating && !isExpanded && "inset-x-0 bottom-0 rounded-2xl shadow-lg",
            isExpanded && "inset-x-px bottom-px rounded-b-xl",
            isMinimized && "invisible w-[var(--side-pane-full-view-frame-width)]",
          )}
        >
          <div
            className={cn(
              "h-full",
              isFloating &&
                "absolute inset-x-0 bottom-0 h-[var(--side-pane-full-view-pane-height)]",
            )}
          >
            {children}
          </div>
        </div>
      </ConversationPanePresentationContext.Provider>
    </div>
  );
}
