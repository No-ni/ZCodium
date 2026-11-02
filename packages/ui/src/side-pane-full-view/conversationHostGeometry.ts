// Side Pane 完整视图对话宿主的几何写入层（spec：docs/ui/side-pane-full-view.md）。
// 从 ConversationHost.tsx 拆出：几何测量与 style 写入是同一段 DOM 投影，不建状态、不调服务、
// 不反向引用父文件；测量顺序、写入顺序与最小化切换的过渡处理逐字不变。
import type { RefObject } from "react";
import type { FloatingAnchor, SidePaneFullViewHostMode } from "@/side-pane-full-view/contract.js";
import {
  clampFloatingPosition,
  resolveFloatingPosition,
  resolveFloatingTransformOrigin,
  resolveFloatingWidth,
  type FloatingPosition,
  type FloatingRect,
} from "@/side-pane-full-view/model.js";

type ConversationHostFrameSize =
  | { width: number; height: number }
  | {
      width: number;
      height: number;
      paneHeight: number;
      clipHeight: number;
      drawerHeight: number;
    };

export function readSlotRect(slot: HTMLElement): FloatingRect {
  const rect = slot.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

export function applyConversationHostGeometry({
  host,
  slotElement,
  mode,
  anchor,
  isMinimized,
  resolveFrameSize,
  dragPositionRef,
  appliedMinimizedRef,
}: {
  host: HTMLElement;
  slotElement: HTMLElement;
  mode: SidePaneFullViewHostMode;
  anchor: FloatingAnchor;
  isMinimized: boolean;
  resolveFrameSize: (slot: FloatingRect) => ConversationHostFrameSize;
  dragPositionRef: RefObject<FloatingPosition | null>;
  appliedMinimizedRef: RefObject<boolean | null>;
}) {
  const slot = readSlotRect(slotElement);
  if (mode === "conversation") {
    host.style.left = `${slot.left}px`;
    host.style.top = `${slot.top}px`;
    host.style.width = `${slot.width}px`;
    host.style.height = `${slot.height}px`;
    return;
  }
  const size = resolveFrameSize(slot);
  // 修复原因：恢复时宽度从圆形按钮的 48px 过渡到 560px，单行输入框在窄宽度下折成多行，
  // 测得的输入区高度先变大（实测 258px）再缩回 46px，浮窗背景先变高再往下掉。
  // 最小化与恢复之间切换时几何直接到位，只做从按钮所在角缩放 + 淡入（transform 不触发重排）。
  const crossingMinimized =
    appliedMinimizedRef.current !== null && appliedMinimizedRef.current !== isMinimized;
  appliedMinimizedRef.current = isMinimized;
  if (crossingMinimized) host.style.transition = "none";
  // 内部内容始终按浮窗宽度排版：最小化期间也不跟着 48px 重排，测得的输入区高度保持正确。
  host.style.setProperty(
    "--side-pane-full-view-frame-width",
    `${resolveFloatingWidth(slot.width)}px`,
  );
  if ("paneHeight" in size) {
    host.style.setProperty("--side-pane-full-view-pane-height", `${size.paneHeight}px`);
    host.style.setProperty("--side-pane-full-view-clip-height", `${size.clipHeight}px`);
    host.style.setProperty("--side-pane-full-view-drawer-height", `${size.drawerHeight}px`);
  }
  const position = dragPositionRef.current
    ? clampFloatingPosition(dragPositionRef.current, slot, size)
    : resolveFloatingPosition(anchor, slot, size);
  host.style.left = `${position.left}px`;
  host.style.top = `${position.top}px`;
  host.style.width = `${size.width}px`;
  host.style.height = `${size.height}px`;
  if (crossingMinimized) {
    // 强制提交一次样式，让上面的几何不带过渡生效，再恢复 CSS 过渡。
    void host.offsetWidth;
    host.style.removeProperty("transition");
    host.style.transformOrigin = resolveFloatingTransformOrigin(anchor);
    host.animate?.(
      [
        { opacity: 0, transform: "scale(0.92)" },
        { opacity: 1, transform: "scale(1)" },
      ],
      { duration: 150, easing: "ease-out" },
    );
  }
}
