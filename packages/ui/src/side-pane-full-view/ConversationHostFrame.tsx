// Side Pane 完整视图对话宿主的纯展示层（spec：docs/ui/side-pane-full-view.md）。
// 从 ConversationHost.tsx 拆出：几何测量、拖拽会话、焦点与菜单状态都留在父组件，这里只按 props
// 渲染同一棵 DOM——不建状态、不调服务、不反向引用父文件，事件顺序与 DOM 结构逐字不变。
import type { FocusEventHandler, PointerEventHandler, ReactNode, RefObject } from "react";
import { GripVerticalIcon, LoaderIcon, Maximize2Icon, MinusIcon, XIcon } from "lucide-react";
import {
  TID_SIDE_PANE_FULL_VIEW_ANSWER_BUBBLE,
  TID_SIDE_PANE_FULL_VIEW_ANSWER_BUBBLE_CLOSE,
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
} from "@zcode/shared/test-ids";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { LucideIcon } from "lucide-react";
import type {
  ConversationPaneFloatingStatus,
  ConversationPanePresentationValue,
  FloatingAnchor,
  FloatingAnswer,
  SidePaneFullViewFloating,
  SidePaneFullViewHostMode,
} from "@/side-pane-full-view/contract.js";
import { ConversationPanePresentationContext } from "@/side-pane-full-view/conversationPanePresentation.js";

type ConversationHostIntl = ReturnType<typeof useZCodeIntl>["intl"];
type ConversationHostStatus = Pick<
  ConversationPaneFloatingStatus,
  "running" | "blockingInteractionId" | "ownerKey"
>;
/** 松手时才决定是否当作点击：拖动过的会话交给吸附计算，否则执行 onClick。 */
type ConversationHostEndDrag = (
  event: Parameters<PointerEventHandler<HTMLElement>>[0],
  onClick: () => void,
) => void;

export function ConversationHostFrame({
  mode,
  floating,
  anchor,
  hostRef,
  isFloating,
  isMinimized,
  isExpanded,
  headerVisible,
  dragging,
  status,
  answer,
  answerPreview,
  statusIcon,
  statusLabel,
  handleLabel,
  expandLabel,
  ExpandIcon,
  menuOpen,
  onMenuOpenChange,
  presentationValue,
  intl,
  onOpenConversation,
  onFocusCapture,
  onBlurCapture,
  onOpenAnswer,
  onDismissAnswer,
  onMinimize,
  onToggleExpanded,
  onRestore,
  onBeginDrag,
  onMoveDrag,
  onEndDrag,
  onCancelDrag,
  children,
}: {
  mode: SidePaneFullViewHostMode;
  floating: SidePaneFullViewFloating;
  anchor: FloatingAnchor;
  hostRef: RefObject<HTMLDivElement | null>;
  isFloating: boolean;
  isMinimized: boolean;
  isExpanded: boolean;
  headerVisible: boolean;
  dragging: boolean;
  status: ConversationHostStatus;
  answer: FloatingAnswer | null;
  answerPreview: string;
  statusIcon: ReactNode;
  statusLabel: string;
  handleLabel: string;
  expandLabel: string;
  ExpandIcon: LucideIcon;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  presentationValue: ConversationPanePresentationValue;
  intl: ConversationHostIntl;
  onOpenConversation: () => void;
  onFocusCapture: FocusEventHandler<HTMLDivElement>;
  onBlurCapture: FocusEventHandler<HTMLDivElement>;
  onOpenAnswer: () => void;
  onDismissAnswer: () => void;
  onMinimize: () => void;
  onToggleExpanded: () => void;
  onRestore: () => void;
  onBeginDrag: PointerEventHandler<HTMLElement>;
  onMoveDrag: PointerEventHandler<HTMLElement>;
  onEndDrag: ConversationHostEndDrag;
  onCancelDrag: () => void;
  children: ReactNode;
}) {
  return (
    <div
      ref={hostRef}
      data-testid={TID_SIDE_PANE_FULL_VIEW_HOST}
      data-side-pane-full-view-host={mode}
      data-floating={isFloating ? floating : undefined}
      data-header-visible={headerVisible ? "true" : "false"}
      data-dragging={dragging ? "true" : undefined}
      data-running={status.running ? "true" : "false"}
      onFocusCapture={isFloating ? onFocusCapture : undefined}
      onBlurCapture={isFloating ? onBlurCapture : undefined}
      className={cn(
        mode === "normal" && "relative h-full w-full",
        mode === "conversation" && "fixed z-30 flex flex-col",
        isFloating &&
          "fixed z-30 transition-[left,top,width,height] duration-150 ease-out data-[dragging=true]:transition-none",
      )}
    >
      <ConversationPanePresentationContext.Provider value={presentationValue}>
        {answer ? (
          // 回答气泡：只显示回答正文前两行，不显示图标与标题；顶部吸附位置时放在浮窗下方。
          <div
            data-testid={TID_SIDE_PANE_FULL_VIEW_ANSWER_BUBBLE}
            className={cn(
              "absolute inset-x-0 z-20",
              anchor.startsWith("top") ? "top-full mt-2" : "bottom-full mb-2",
            )}
          >
            <button
              type="button"
              aria-label={intl.formatMessage({ id: "sidePane.fullView.openAnswer" })}
              className="block w-full rounded-2xl border border-border bg-background px-4 py-3 text-left shadow-lg transition-colors hover:bg-hover"
              onClick={onOpenAnswer}
            >
              <span className="line-clamp-2 text-ui-base text-foreground">{answerPreview}</span>
            </button>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              data-testid={TID_SIDE_PANE_FULL_VIEW_ANSWER_BUBBLE_CLOSE}
              aria-label={intl.formatMessage({ id: "common.close" })}
              className="absolute -top-2 -left-2 rounded-full border bg-background shadow-sm"
              // 关闭不夺走输入框焦点，避免抽屉因焦点进出闪一下。
              onMouseDown={(event) => event.preventDefault()}
              onClick={onDismissAnswer}
            >
              <XIcon className="size-3" />
            </Button>
          </div>
        ) : null}
        {isFloating && !isMinimized ? (
          // 抽屉层：在输入框后面，聚焦时随浮窗变高从输入框后面向上滑出；展开时铺满整个浮窗。
          <div
            data-testid={TID_SIDE_PANE_FULL_VIEW_DRAWER}
            data-open={headerVisible ? "true" : "false"}
            className={cn(
              "absolute inset-x-0 top-0 h-[var(--side-pane-full-view-drawer-height)] overflow-hidden rounded-2xl border border-border bg-background shadow-lg transition-[height,opacity] duration-150 ease-out",
              headerVisible ? "opacity-100" : "pointer-events-none opacity-0",
            )}
          >
            {headerVisible ? (
              <div
                data-testid={TID_SIDE_PANE_FULL_VIEW_HEADER}
                data-expanded={isExpanded ? "true" : "false"}
                className="flex h-10 items-center gap-1 px-2"
                // 修复原因：菜单内容虽 portal 到 body，React 合成事件仍沿组件树冒泡；操作栏容器
                // 不挂点击行为，只阻止 mousedown 抢走输入框焦点，避免操作栏在点击前因失焦消失。
                onMouseDown={(event) => event.preventDefault()}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  data-testid={TID_SIDE_PANE_FULL_VIEW_MINIMIZE}
                  aria-label={intl.formatMessage({ id: "sidePane.fullView.minimize" })}
                  onClick={onMinimize}
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
                  title={expandLabel}
                  onClick={onToggleExpanded}
                >
                  <ExpandIcon className="size-4" />
                </Button>
                {status.running ? (
                  <span
                    role="status"
                    data-testid={TID_SIDE_PANE_FULL_VIEW_RUNNING}
                    aria-label={statusLabel}
                    title={statusLabel}
                    className="flex size-6 items-center justify-center"
                  >
                    <LoaderIcon
                      className="size-4 animate-spin text-foreground-subtle"
                      aria-hidden="true"
                    />
                  </span>
                ) : null}
                <div className="min-w-0 flex-1" />
                <DropdownMenu open={menuOpen} onOpenChange={onMenuOpenChange} modal={false}>
                  <ControlHintTooltip title={handleLabel} side="top" align="end">
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        data-testid={TID_SIDE_PANE_FULL_VIEW_HANDLE}
                        aria-label={handleLabel}
                        className="cursor-grab touch-none data-[state=open]:bg-selected"
                        onPointerDown={onBeginDrag}
                        onPointerMove={onMoveDrag}
                        onPointerUp={(event) => onEndDrag(event, () => onMenuOpenChange(true))}
                        onPointerCancel={onCancelDrag}
                      >
                        <GripVerticalIcon className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                  </ControlHintTooltip>
                  <DropdownMenuContent align="end" side="top" className="w-52">
                    <DropdownMenuItem
                      data-testid={TID_SIDE_PANE_FULL_VIEW_MENU_OPEN_CONVERSATION}
                      onSelect={onOpenConversation}
                    >
                      <Maximize2Icon className="size-4" />
                      {intl.formatMessage({ id: "sidePane.fullView.openConversation" })}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      data-testid={TID_SIDE_PANE_FULL_VIEW_MENU_MINIMIZE}
                      onSelect={onMinimize}
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
            className="absolute inset-0 z-10 flex cursor-grab touch-none items-center justify-center rounded-full border border-border bg-background shadow-lg hover:bg-hover"
            onPointerDown={onBeginDrag}
            onPointerMove={onMoveDrag}
            onPointerUp={(event) => onEndDrag(event, onRestore)}
            onPointerCancel={onCancelDrag}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onRestore();
              }
            }}
          >
            {statusIcon}
          </button>
        ) : null}
        <div
          data-side-pane-full-view-clip=""
          className={cn(
            "relative min-h-0",
            mode === "normal" && "h-full",
            mode === "conversation" && "flex-1",
            // 输入层：收起态外壳就是输入框（带阴影），展开态内缩 1px 露出抽屉边框。
            isFloating &&
              "absolute z-10 h-[var(--side-pane-full-view-clip-height)] overflow-hidden",
            isFloating && !isExpanded && "inset-x-0 bottom-0 rounded-2xl shadow-lg",
            isExpanded && "inset-x-px bottom-px rounded-b-2xl",
            // 最小化时输入层不可见，但保持浮窗宽度排版，不随 48px 的按钮重排。
            isMinimized && "invisible w-[var(--side-pane-full-view-frame-width)]",
          )}
        >
          <div
            className={cn(
              "h-full",
              // 收起态保持展开态的固定高度并贴底：只露出底部输入区，上方内容仍然挂载。
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
