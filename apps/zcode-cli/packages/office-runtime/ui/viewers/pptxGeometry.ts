import {
  materializeSlideNodes,
  type PresentationData,
  type SlideHandle,
  type SlideNode,
} from "@aiden0z/pptx-renderer/browser";

export interface SlideSlot {
  frame: HTMLDivElement;
  host: HTMLDivElement;
  overlay: HTMLDivElement;
  handle?: SlideHandle;
  ready?: Promise<void>;
}

/** Topmost shape under a point in native slide coordinates. */
export function hitSlide(
  built: PresentationData | null,
  index: number,
  x: number,
  y: number,
): SlideNode | null {
  if (!built) return null;
  const slide = built.slides[index];
  materializeSlideNodes(built, slide);
  for (let i = slide.nodes.length - 1; i >= 0; i--) {
    const node = slide.nodes[i];
    const { x: left, y: top } = node.position;
    const { w, h } = node.size;
    if (w <= 0 && h <= 0) continue;
    const pad = Math.min(w, h) < 6 ? 4 : 0;
    if (x >= left - pad && x <= left + w + pad && y >= top - pad && y <= top + h + pad) return node;
  }
  return null;
}

export function outline(slot: SlideSlot, node: SlideNode | null, kind: "selected" | "revealed") {
  slot.overlay.querySelectorAll(`.shape-${kind}`).forEach((element) => element.remove());
  if (!node) return;
  const box = document.createElement("div");
  box.className = `shape-${kind}`;
  box.style.left = `${node.position.x}px`;
  box.style.top = `${node.position.y}px`;
  box.style.width = `${node.size.w}px`;
  box.style.height = `${node.size.h}px`;
  slot.overlay.append(box);
}
