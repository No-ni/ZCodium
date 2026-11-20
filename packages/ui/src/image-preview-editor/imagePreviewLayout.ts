import type { AnnotationTool, Point, Size, Transform } from "@/image-preview-editor/geometry.js";
// 预览布局推导：与拆分前 ImagePreviewSurface 内的 fit/size/canPan/cursor 同算法，只做纯计算，不持状态。
export function getImagePreviewLayout(
  viewport: Size,
  natural: Size,
  transform: Transform,
  tool: AnnotationTool,
  dragging: boolean,
) {
  const fit = Math.min(
    1,
    viewport.width / (natural.width || 1),
    viewport.height / (natural.height || 1),
  );
  const size = { width: natural.width * fit, height: natural.height * fit };
  const canPan =
    size.width * transform.scale > viewport.width + 1 ||
    size.height * transform.scale > viewport.height + 1;
  const cursor =
    tool === "select"
      ? canPan
        ? dragging
          ? "grabbing"
          : "grab"
        : "default"
      : tool === "text"
        ? "text"
        : "crosshair";
  return { fit, size, canPan, cursor };
}

// 渲染矩形只声明定位与尺寸，纯函数不依赖具体 DOM 矩形类型。
interface PreviewRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

// client 坐标经渲染矩形换算为自然像素坐标；公式与拆分前 ImagePreviewSurface 的 point(client) 一致。
export function toImagePoint(rect: PreviewRect, natural: Size, client: Point): Point {
  return {
    x: Math.max(0, Math.min(natural.width, ((client.x - rect.left) / rect.width) * natural.width)),
    y: Math.max(
      0,
      Math.min(natural.height, ((client.y - rect.top) / rect.height) * natural.height),
    ),
  };
}
/** 屏幕坐标已经包含变换；按真实图形边界定位添加按钮。 */
export function getDrawingAddPosition(
  drawing: Pick<DOMRect, "left" | "width" | "bottom">,
  bounds: Pick<DOMRect, "left" | "top" | "width" | "height">,
  offset: { left: number; top: number },
  buttonWidth: number,
) {
  const halfWidth = buttonWidth / 2;
  return {
    left:
      offset.left +
      Math.max(
        halfWidth,
        Math.min(bounds.width - halfWidth, drawing.left + drawing.width / 2 - bounds.left),
      ),
    top: offset.top + Math.max(8, Math.min(bounds.height + 12, drawing.bottom - bounds.top + 12)),
  };
}

import type { Annotation } from "./geometry.js";

export function handleImagePreviewKeyboard(
  event: KeyboardEvent,
  state: {
    editing: boolean;
    saving: boolean;
    actionBusy: boolean;
    pendingExit: boolean;
    selected: string | null;
    annotations: readonly Annotation[];
  },
  actions: {
    undo: () => void;
    redo: () => void;
    commit: (annotations: Annotation[]) => void;
    clearSelected: () => void;
  },
) {
  if (
    !state.editing ||
    state.saving ||
    state.actionBusy ||
    state.pendingExit ||
    (event.target instanceof Element &&
      event.target.closest("input,textarea,[contenteditable=true]"))
  )
    return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    if (event.shiftKey) actions.redo();
    else actions.undo();
  } else if (state.selected && (event.key === "Delete" || event.key === "Backspace")) {
    event.preventDefault();
    actions.commit(state.annotations.filter((a) => a.id !== state.selected));
    actions.clearSelected();
  }
}

export function getVisibleImageAnnotations(
  annotations: readonly Annotation[],
  draft: Annotation | null,
  textDraft: Annotation | null,
  selected: string | null,
) {
  const displayed = annotations.map((a) => (draft?.id === a.id ? draft : a));
  if (draft && !annotations.some((a) => a.id === draft.id)) displayed.push(draft);
  if (textDraft?.text?.trim()) displayed.push(textDraft);
  const activeDrawingId = textDraft?.text?.trim()
    ? textDraft.id
    : (draft?.id ?? displayed.find((item) => item.id === selected)?.id ?? displayed.at(-1)?.id);
  return { displayed, activeDrawingId };
}
