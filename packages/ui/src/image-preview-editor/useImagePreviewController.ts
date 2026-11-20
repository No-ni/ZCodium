import { useImagePreviewViewport } from "./useImagePreviewViewport.js";
import { saveImagePreview } from "./saveImagePreview.js";
import {
  useEffect,
  useLayoutEffect,
  useEffectEvent,
  useRef,
  useState,
  type PointerEvent,
} from "react";

import { useZCodeIntl } from "@/i18n/IntlProvider.js";

import type { ImagePreviewSurfaceProps } from "@/image-preview-editor/contract.js";

import {
  clampOffset,
  zoomAtPoint,
  updateHistory,
  undoHistory,
  redoHistory,
  type Point,
  type Annotation,
  type AnnotationTool,
  type History,
  type Transform,
} from "@/image-preview-editor/geometry.js";
import {
  getImagePreviewLayout,
  toImagePoint,
  getDrawingAddPosition,
  getVisibleImageAnnotations,
  handleImagePreviewKeyboard,
} from "@/image-preview-editor/imagePreviewLayout.js";

type Gesture = { start: Point; transform: Transform; annotation?: Annotation; moving?: boolean };
const ZERO = { x: 0, y: 0 };
export function useImagePreviewController({
  alt,
  filename,
  onSaved,
  onNavigationGuardChange,
}: ImagePreviewSurfaceProps) {
  const { intl } = useZCodeIntl();
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  const actionPending = useRef(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [pendingExit, setPendingExit] = useState<(() => void) | null>(null);
  const [editing, setEditing] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null),
    surfaceRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null),
    overlayRef = useRef<SVGSVGElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const [addPosition, setAddPosition] = useState<{ left: number; top: number } | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [transform, setTransform] = useState<Transform>({ scale: 1, offset: ZERO });
  const [tool, setTool] = useState<AnnotationTool>("select"),
    [color, setColor] = useState("#ef4444");
  const [history, setHistory] = useState<History<Annotation>>({
    past: [],
    present: [],
    future: [],
  });
  const [draft, setDraft] = useState<Annotation | null>(null),
    [selected, setSelected] = useState<string | null>(null);
  const [textDraft, setTextDraft] = useState<Annotation | null>(null),
    [saving, setSaving] = useState(false),
    [dragging, setDragging] = useState(false);
  const gestureRef = useRef<Gesture | null>(null),
    draftRef = useRef<Annotation | null>(null);
  const pointers = useRef(new Map<number, Point>()),
    pinch = useRef<{ distance: number; transform: Transform } | null>(null);
  const savePending = useRef(false),
    alive = useRef(true);
  const { fit, size, canPan, cursor } = getImagePreviewLayout(
    viewport,
    natural,
    transform,
    tool,
    dragging,
  );
  const { displayed, activeDrawingId } = getVisibleImageAnnotations(
    history.present,
    draft,
    textDraft,
    selected,
  );
  const commit = (annotations: Annotation[]) => setHistory((h) => updateHistory(h, annotations));
  const setCurrentDraft = (value: Annotation | null) => {
    draftRef.current = value;
    setDraft(value);
  };
  const undo = () => {
    setHistory(undoHistory);
    setSelected(null);
    setTextDraft(null);
  };
  const redo = () => {
    setHistory(redoHistory);
    setSelected(null);
    setTextDraft(null);
  };
  const applyTransform = (value: Transform) =>
    setTransform({ ...value, offset: clampOffset(value.offset, value.scale, size, viewport) });
  const zoom = (scale: number, anchor: Point = ZERO) =>
    applyTransform(zoomAtPoint(transform, Math.min(3, Math.max(0.5, scale)), anchor));
  const point = (client: Point): Point =>
    toImagePoint(surfaceRef.current!.getBoundingClientRect(), natural, client);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useImagePreviewViewport(viewportRef, setViewport);
  useEffect(() => {
    setTransform((current) => ({
      ...current,
      offset: clampOffset(current.offset, current.scale, size, viewport),
    }));
  }, [size.width, size.height, viewport.width, viewport.height]);
  const onWheel = useEffectEvent((event: WheelEvent) => {
    if (saving || actionBusy || pendingExit || gestureRef.current || !natural.width) return;
    event.preventDefault();
    const rect = viewportRef.current!.getBoundingClientRect();
    const delta =
      event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
    zoom(transform.scale * Math.exp(-Math.max(-300, Math.min(300, delta)) * 0.002), {
      x: event.clientX - rect.left - rect.width / 2,
      y: event.clientY - rect.top - rect.height / 2,
    });
  });
  useEffect(() => {
    const viewport = viewportRef.current;
    // React 的委托 wheel 默认 passive，无法阻止页面滚动；监听仅归当前图片视口所有。
    const listener = (event: WheelEvent) => onWheel(event);
    viewport?.addEventListener("wheel", listener, { passive: false });
    return () => viewport?.removeEventListener("wheel", listener);
  }, []);
  const onKeyboard = useEffectEvent((event: KeyboardEvent) => {
    handleImagePreviewKeyboard(
      event,
      {
        editing,
        saving,
        actionBusy,
        pendingExit: Boolean(pendingExit),
        selected,
        annotations: history.present,
      },
      { undo, redo, commit, clearSelected: () => setSelected(null) },
    );
  });
  useEffect(() => {
    const listener = (e: KeyboardEvent) => onKeyboard(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (saving || actionBusy || pendingExit || event.button !== 0 || !natural.width) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const client = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, client);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { distance: Math.hypot(b!.x - a!.x, b!.y - a!.y), transform };
      setCurrentDraft(null);
      gestureRef.current = null;
      return;
    }
    const start = point(client);
    const id = (event.target as Element)
      .closest("[data-annotation-id]")
      ?.getAttribute("data-annotation-id");
    // 收起标注后只允许预览拖动，不再命中历史标注；隐藏工具栏不能留下隐形编辑入口。
    const annotation = editing ? history.present.find((a) => a.id === id) : undefined;
    if (tool === "text") {
      if (textDraft?.text?.trim()) commit([...history.present, textDraft]);
      setTextDraft({
        id: crypto.randomUUID(),
        tool: "text",
        color,
        width: Math.max(2, 4 / fit),
        points: [start],
        text: "",
      });
      return;
    }
    if (tool === "select") {
      setSelected(annotation?.id ?? null);
      setDragging(Boolean(annotation || canPan));
      gestureRef.current = {
        start: annotation ? start : client,
        transform,
        annotation,
        moving: Boolean(annotation),
      };
      return;
    }
    const mark: Annotation = {
      id: crypto.randomUUID(),
      tool,
      color,
      width: Math.max(2, 3 / fit),
      points: [start],
    };
    gestureRef.current = { start, transform, annotation: mark };
    setCurrentDraft(mark);
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    const client = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, client);
    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const scale = Math.min(
        3,
        Math.max(
          0.5,
          (pinch.current.transform.scale * Math.hypot(b!.x - a!.x, b!.y - a!.y)) /
            (pinch.current.distance || 1),
        ),
      );
      applyTransform({ ...pinch.current.transform, scale });
      return;
    }
    const gesture = gestureRef.current;
    if (!gesture) return;
    if (!gesture.annotation) {
      if (canPan)
        applyTransform({
          ...transform,
          offset: {
            x: gesture.transform.offset.x + client.x - gesture.start.x,
            y: gesture.transform.offset.y + client.y - gesture.start.y,
          },
        });
      return;
    }
    const current = point(client),
      mark = gesture.annotation;
    if (gesture.moving) {
      setCurrentDraft({
        ...mark,
        points: mark.points.map((p) => ({
          x: p.x + current.x - gesture.start.x,
          y: p.y + current.y - gesture.start.y,
        })),
      });
      return;
    }
    setCurrentDraft({
      ...mark,
      points:
        mark.tool === "pen"
          ? [...(draftRef.current?.points ?? mark.points), current]
          : [gesture.start, current],
    });
  };
  const pointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    const mark = draftRef.current;
    // 原生取色器关闭后，松手可能先发 lostpointercapture 再发 pointerup；
    // buttons=0 表示已松手，仍需提交笔画，否则完整笔画会被误当取消而丢失。
    // 真正的 cancel / 按住时失去捕获仍丢弃草稿，后续重复结束事件由 pointer 集合过滤。
    const completed =
      event.type === "pointerup" || (event.type === "lostpointercapture" && event.buttons === 0);
    if (completed && mark)
      commit(
        gestureRef.current?.moving
          ? history.present.map((a) => (a.id === mark.id ? mark : a))
          : [...history.present, mark],
      );
    setCurrentDraft(null);
    gestureRef.current = null;
    pinch.current = null;
    setDragging(false);
  };
  const dirty = displayed.length > 0;
  useLayoutEffect(() => {
    const viewportElement = viewportRef.current;
    const button = addButtonRef.current;
    const group = Array.from(overlayRef.current?.children ?? []).find(
      (element) => element.getAttribute("data-annotation-id") === activeDrawingId,
    );
    if (!viewportElement || !button || !group?.firstElementChild) return;
    // 按实际 SVG 图形包围盒定位，不能把整张图片底边当作用户刚画的圆圈底边。
    // 屏幕坐标已包含缩放和平移，文字/箭头也沿用真实渲染尺寸，不另猜路径范围。
    const drawing = group.firstElementChild.getBoundingClientRect();
    const bounds = viewportElement.getBoundingClientRect();
    const { left, top } = getDrawingAddPosition(
      drawing,
      bounds,
      { left: viewportElement.offsetLeft, top: viewportElement.offsetTop },
      button.offsetWidth,
    );
    setAddPosition((previous) =>
      previous?.left === left && previous.top === top ? previous : { left, top },
    );
  }, [activeDrawingId, history.present, draft, textDraft, selected, transform, viewport, natural]);
  useLayoutEffect(() => {
    // 编辑器是唯一修改状态持有者；所有关闭/切图入口只提交离开请求，不自行销毁草稿。
    onNavigationGuardChange?.((proceed) => {
      if (savePending.current || actionPending.current || pendingExit) return;
      if (dirty) {
        // Esc 可能发生在按住绘图期间：先固定可见笔画并释放捕获，防止弹窗背后继续移动或重复提交。
        const mark = draftRef.current;
        const moving = gestureRef.current?.moving;
        if (mark)
          setHistory((current) =>
            updateHistory(
              current,
              moving
                ? current.present.map((item) => (item.id === mark.id ? mark : item))
                : [...current.present, mark],
            ),
          );
        setCurrentDraft(null);
        gestureRef.current = null;
        pinch.current = null;
        const capturedPointers = [...pointers.current.keys()];
        pointers.current.clear();
        for (const id of capturedPointers) {
          if (surfaceRef.current?.hasPointerCapture(id))
            surfaceRef.current.releasePointerCapture(id);
        }
        setDragging(false);
        setPendingExit((current) => current ?? proceed);
      } else proceed();
    });
    return () => onNavigationGuardChange?.(null);
  }, [dirty, pendingExit, onNavigationGuardChange]);
  const save = () =>
    saveImagePreview({
      image: imageRef.current,
      overlay: overlayRef.current,
      filename: filename || alt,
      pending: savePending,
      alive,
      setSaving,
      intl,
      onSaved,
    });
  return {
    intl,
    keepEditingRef,
    actionPending,
    actionBusy,
    setActionBusy,
    pendingExit,
    setPendingExit,
    editing,
    setEditing,
    viewportRef,
    surfaceRef,
    imageRef,
    overlayRef,
    addButtonRef,
    addPosition,
    natural,
    setNatural,
    transform,
    setTransform,
    tool,
    setTool,
    color,
    setColor,
    history,
    selected,
    setSelected,
    textDraft,
    setTextDraft,
    saving,
    size,
    cursor,
    displayed,
    commit,
    undo,
    redo,
    zoom,
    pointerDown,
    pointerMove,
    pointerEnd,
    dirty,
    save,
  };
}
