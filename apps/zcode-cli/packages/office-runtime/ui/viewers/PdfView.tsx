import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { parseLocator } from "#office/domain/anchor.ts";
import { scrollToElement, selectionIn } from "#ui/dom.ts";
import {
  AssetCMapFactory,
  AssetBinaryFactory,
  worker,
  pageTextContent,
  capturePdfPage,
  rasterPage,
  type PageSlot,
} from "#ui/viewers/pdfAssets.ts";
import { addPdfLinks } from "#ui/viewers/pdfLinks.ts";
import { createPdfMarks } from "#ui/viewers/pdfMarks.ts";
import { usePdfInteraction } from "#ui/viewers/usePdfInteraction.ts";
import { nextZoom, type FitMode, type ViewerHandle, type ViewerProps } from "#ui/viewers/types.ts";

const PADDING = 16;
/** pdf.js scale 1 is 72 dpi; actual size uses 96 CSS pixels per inch. */
const CSS_UNITS = 96 / 72;
const PAGE_RENDER_ATTEMPTS = 5;
interface Zoom {
  mode: FitMode | null;
  percent: number;
}

export const PdfView = forwardRef<ViewerHandle, ViewerProps>(function PdfView(props, ref) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const slots = useRef<PageSlot[]>([]);
  const sizes = useRef<{ width: number; height: number }[]>([]);
  const [zoom, setZoom] = useState<Zoom>({ mode: "width", percent: 100 });
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [loaded, setLoaded] = useState(0);
  const ready = useRef(false);
  const callbacks = useRef(props);
  callbacks.current = props;
  const glance = Boolean(props.glance);
  const scale = (() => {
    if (!loaded || !box.width || !sizes.current.length) return 0;
    const maxWidth = Math.max(...sizes.current.map((size) => size.width));
    const maxHeight = Math.max(...sizes.current.map((size) => size.height));
    const columns = glance && box.width >= 520 ? 2 : 1;
    const fitWidth = Math.min(4, (box.width - PADDING * (columns + 1)) / columns / maxWidth);
    if (zoom.mode === "width" || glance) return fitWidth;
    if (zoom.mode === "page") return Math.min(fitWidth, (box.height - PADDING * 2) / maxHeight);
    if (zoom.mode === "actual") return CSS_UNITS;
    return (zoom.percent / 100) * CSS_UNITS;
  })();
  const scaleRef = useRef(scale);
  const previousScale = useRef(0);
  scaleRef.current = scale;
  const zoomAnchor = useRef<{ x: number; y: number } | null>(null);
  const observer = useRef<IntersectionObserver | null>(null);
  const generation = useRef(0);
  const [marks] = useState(() =>
    createPdfMarks({
      document: () => docRef.current,
      pages: () => slots.current,
      scroll: () => scrollRef.current,
      rendered,
      async text(page) {
        const doc = docRef.current;
        if (!doc) return "";
        const content = await pageTextContent(await doc.getPage(page));
        return content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
      },
      scrollToPage,
    }),
  );

  useEffect(() => {
    let cancelled = false;
    let loading: ReturnType<typeof pdfjs.getDocument> | null = null;
    ready.current = false;
    (async () => {
      const pdfWorker = await worker();
      if (cancelled) return;
      loading = pdfjs.getDocument({
        worker: pdfWorker,
        data: new Uint8Array(props.bytes.slice(0)),
        cMapUrl: "pdfjs/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "pdfjs/standard_fonts/",
        wasmUrl: "pdfjs/wasm/",
        CMapReaderFactory: AssetCMapFactory,
        StandardFontDataFactory: AssetBinaryFactory,
        WasmFactory: AssetBinaryFactory,
        useWorkerFetch: false,
        isEvalSupported: false,
        enableXfa: false,
      });
      const doc = await loading.promise;
      if (cancelled) return;
      docRef.current = doc;
      const pageSizes: { width: number; height: number }[] = [];
      const count = glance ? Math.min(4, doc.numPages) : doc.numPages;
      for (let n = 1; n <= count; n++) {
        const viewport = (await doc.getPage(n)).getViewport({ scale: 1 });
        if (cancelled) return;
        pageSizes.push({ width: viewport.width, height: viewport.height });
      }
      sizes.current = pageSizes;
      const container = scrollRef.current!;
      container.replaceChildren();
      slots.current = pageSizes.map((_, i) => {
        const element = document.createElement("div");
        element.className = "pdf-page";
        element.dataset.at = `page:${i + 1}`;
        container.append(element);
        return { element };
      });
      setBox({ width: container.clientWidth, height: container.clientHeight });
      setLoaded((value) => value + 1);
      callbacks.current.onPage?.({ current: 1, count: doc.numPages });
    })().catch(() => !cancelled && callbacks.current.onError(new Error("PDF loading failed.")));
    return () => {
      cancelled = true;
      ++generation.current;
      observer.current?.disconnect();
      for (const slot of slots.current) slot.task?.cancel();
      marks.reset();
      slots.current = [];
      docRef.current = null;
      void loading?.destroy();
    };
  }, [props.bytes, glance, marks]);

  useEffect(() => {
    const container = scrollRef.current!;
    const resize = new ResizeObserver(() =>
      setBox((previous) =>
        Math.abs(previous.width - container.clientWidth) > 1 ||
        Math.abs(previous.height - container.clientHeight) > 1
          ? { width: container.clientWidth, height: container.clientHeight }
          : previous,
      ),
    );
    resize.observe(container);
    return () => resize.disconnect();
  }, []);
  useEffect(() => {
    if (scale)
      callbacks.current.onZoom?.({
        mode: zoom.mode,
        percent: Math.round((scale / CSS_UNITS) * 100),
      });
  }, [scale, zoom.mode]);

  useLayoutEffect(() => {
    const doc = docRef.current;
    const container = scrollRef.current;
    if (!doc || !scale || !container) return;
    const before = previousScale.current;
    previousScale.current = scale;
    const anchor = zoomAnchor.current ?? {
      x: container.clientWidth / 2,
      y: container.clientHeight / 2,
    };
    zoomAnchor.current = null;
    const fraction = { x: container.scrollLeft + anchor.x, y: container.scrollTop + anchor.y };
    observer.current?.disconnect();
    ++generation.current;
    for (const [i, slot] of slots.current.entries()) {
      slot.task?.cancel();
      slot.done = undefined;
      slot.textLayer = undefined;
      slot.element.replaceChildren();
      slot.element.style.width = `${sizes.current[i].width * scale}px`;
      slot.element.style.height = `${sizes.current[i].height * scale}px`;
    }
    marks.resize();
    if (before && before !== scale) {
      const ratio = scale / before;
      container.scrollTo({
        left: Math.max(0, (fraction.x - PADDING) * ratio + PADDING - anchor.x),
        top: Math.max(0, (fraction.y - PADDING) * ratio + PADDING - anchor.y),
      });
    }
    observer.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const index = slots.current.findIndex((slot) => slot.element === entry.target);
          if (index >= 0) void renderPage(index);
        }
      },
      { root: container, rootMargin: "600px 0px" },
    );
    for (const slot of slots.current) observer.current.observe(slot.element);
  }, [scale, loaded, marks]);

  function renderPage(index: number): Promise<void> {
    const slot = slots.current[index];
    return slot ? (slot.done ??= draw(index, slot)) : Promise.resolve();
  }
  async function draw(index: number, slot: PageSlot) {
    const doc = docRef.current;
    if (!doc) return;
    const currentScale = scaleRef.current;
    const mine = generation.current;
    const valid = () => generation.current === mine && docRef.current === doc;
    try {
      const page = await doc.getPage(index + 1);
      if (!valid()) return;
      const viewport = page.getViewport({ scale: currentScale });
      const ratio = window.devicePixelRatio || 1;
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const textLayer = document.createElement("div");
      textLayer.className = "textLayer";
      const links = document.createElement("div");
      links.className = "pdf-links";
      slot.element.style.setProperty("--scale-factor", String(currentScale));
      slot.element.style.setProperty("--user-unit", "1");
      slot.element.style.setProperty("--total-scale-factor", String(currentScale));
      slot.element.replaceChildren(canvas, textLayer, links);
      const task = page.render({
        canvas,
        canvasContext: canvas.getContext("2d")!,
        viewport,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
      });
      slot.task = task;
      await task.promise;
      if (!valid()) return;
      // 文字层归一后再提供复制、选区引用、查找和 Agent 引文定位，避免 CJK 兼容字形错位。
      const content = await pageTextContent(page);
      if (!valid()) return;
      const text = new pdfjs.TextLayer({
        textContentSource: content,
        container: textLayer,
        viewport,
      });
      await text.render();
      if (!valid() || !textLayer.isConnected) return;
      slot.textLayer = textLayer;
      await addPdfLinks(page, viewport, links, doc, slots.current);
      if (!valid()) return;
      marks.decorate(index + 1);
      // parser 完成不等于页面已渲染；首个真实 canvas/text-layer 就绪后才允许定位/截图。
      if (!ready.current) {
        ready.current = true;
        callbacks.current.onReady();
      }
    } catch (error) {
      if (valid() && (error as Error)?.name !== "RenderingCancelledException")
        callbacks.current.onError(new Error("PDF rendering failed."));
    }
  }
  function scrollToPage(page: number) {
    const slot = slots.current[page - 1];
    if (slot) scrollToElement(slot.element, "start");
  }
  async function rendered(n: number): Promise<PageSlot | null> {
    const doc = docRef.current;
    const slot = slots.current[n - 1];
    if (!slot) return null;
    for (let attempt = 0; attempt < PAGE_RENDER_ATTEMPTS; attempt++) {
      await renderPage(n - 1);
      if (docRef.current !== doc) return null;
      if (slot.textLayer?.isConnected) return slot;
    }
    return null;
  }
  function stepZoom(direction: 1 | -1) {
    setZoom({
      mode: null,
      percent: nextZoom(Math.round((scaleRef.current / CSS_UNITS) * 100), direction),
    });
  }
  usePdfInteraction({
    scrollRef,
    docRef,
    slots,
    callbacks,
    revealRanges: marks.revealRanges,
    zoomAnchor,
    stepZoom,
  });

  useImperativeHandle(
    ref,
    (): ViewerHandle => ({
      reveal: marks.reveal,
      clearReveal: marks.clearReveal,
      goTo(at) {
        const locator = parseLocator("pdf", at);
        if (locator.kind === "pdf") scrollToPage(locator.from);
      },
      async capture(at, maxWidth) {
        const doc = docRef.current;
        if (!doc) throw new Error("The PDF is still loading.");
        const page = at ? parseLocator("pdf", at) : null;
        const top = scrollRef.current!.getBoundingClientRect().top;
        const number =
          page?.kind === "pdf"
            ? page.from
            : Number(
                (
                  slots.current.find(
                    (slot) => slot.element.getBoundingClientRect().bottom > top + 8,
                  )?.element.dataset.at ?? "page:1"
                ).slice(5),
              );
        if (number < 1 || number > doc.numPages) throw new Error("PDF page is out of range.");
        return {
          ...(await capturePdfPage(await doc.getPage(number), maxWidth)),
          at: `page:${number}`,
        };
      },
      zoom: stepZoom,
      fit(mode) {
        setZoom({ mode, percent: 100 });
      },
      find: marks.find,
      findGo: marks.findGo,
      clearFind: marks.clearFind,
      clearSelection() {
        scrollRef.current
          ?.querySelectorAll(".pdf-page.selected")
          .forEach((element) => element.classList.remove("selected"));
        if (scrollRef.current && selectionIn(scrollRef.current))
          document.getSelection()?.removeAllRanges();
      },
      goToPage(page) {
        scrollToPage(Math.min(Math.max(1, page), slots.current.length));
      },
      async thumbnail(page, width) {
        const doc = docRef.current;
        if (!doc) throw new Error("The PDF is still loading.");
        const canvas = await rasterPage(
          await doc.getPage(page),
          width,
          window.devicePixelRatio || 1,
        );
        canvas.style.width = `${width}px`;
        canvas.style.height = `${(canvas.height / canvas.width) * width}px`;
        return canvas;
      },
    }),
    [marks],
  );
  return <div ref={scrollRef} className={`viewer-scroll pdf-scroll${glance ? " glance" : ""}`} />;
});
