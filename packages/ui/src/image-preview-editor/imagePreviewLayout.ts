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
