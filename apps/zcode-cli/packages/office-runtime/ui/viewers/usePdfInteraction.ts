import { useEffect, type RefObject } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { boxOf, pointOn, selectionIn, trackTopmost } from "#ui/dom.ts";
import type { ViewerProps } from "#ui/viewers/types.ts";
import type { PageSlot } from "#ui/viewers/pdfAssets.ts";

/** PDF local pointer/keyboard selection, visible page and wheel zoom projection. */
export function usePdfInteraction({
  scrollRef,
  docRef,
  slots,
  callbacks,
  revealRanges,
  zoomAnchor,
  stepZoom,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  docRef: RefObject<PDFDocumentProxy | null>;
  slots: RefObject<PageSlot[]>;
  callbacks: RefObject<ViewerProps>;
  revealRanges: RefObject<Map<number, Range>>;
  zoomAnchor: RefObject<{ x: number; y: number } | null>;
  stepZoom(direction: 1 | -1): void;
}) {
  const actions = { stepZoom };
  useEffect(() => {
    const container = scrollRef.current!;
    return trackTopmost(
      container,
      () => slots.current.map((slot) => slot.element),
      (element) => element.dataset.at ?? null,
      (at) => {
        callbacks.current.onLocation(at);
        callbacks.current.onPage?.({
          current: Number(at.slice(5)),
          count: docRef.current?.numPages ?? slots.current.length,
        });
      },
      1 / 3,
    );
  }, [scrollRef, docRef, slots, callbacks]);
  useEffect(() => {
    const container = scrollRef.current!;
    let accumulated = 0;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      accumulated += event.deltaY;
      if (Math.abs(accumulated) < 40) return;
      const direction = accumulated < 0 ? 1 : -1;
      accumulated = 0;
      const rect = container.getBoundingClientRect();
      zoomAnchor.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      actions.stepZoom(direction);
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [scrollRef, zoomAnchor]);
  useEffect(() => {
    const container = scrollRef.current!;
    const pageOf = (node: Node | null) =>
      (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>(".pdf-page")
        ?.dataset.at;
    const clearPage = () =>
      container
        .querySelectorAll(".pdf-page.selected")
        .forEach((element) => element.classList.remove("selected"));
    const report = (event: Event) => {
      const selected = selectionIn(container);
      if (selected) {
        const start = pageOf(selected.range.startContainer),
          end = pageOf(selected.range.endContainer);
        if (!start) return;
        clearPage();
        const a = Number(start.slice(5)),
          b = end ? Number(end.slice(5)) : a;
        const range = selected.range.cloneRange();
        callbacks.current.onSelect(
          { at: b > a ? `page:${a}-${b}` : start, text: selected.text },
          { text: true, locate: () => boxOf(range), user: true },
        );
        return;
      }
      if (event.type !== "mouseup") return;
      const { clientX, clientY } = event as MouseEvent;
      for (const [index, range] of revealRanges.current) {
        if (pointOn(range, clientX, clientY) && callbacks.current.onRevealHit?.(index)) {
          clearPage();
          callbacks.current.onSelect(null);
          return;
        }
      }
      const target = event.target as Element;
      if (target.closest(".pdf-link")) return;
      const page = target.closest<HTMLElement>(".pdf-page");
      clearPage();
      if (!page?.dataset.at || target.closest(".textLayer span")) {
        callbacks.current.onSelect(null);
        return;
      }
      page.classList.add("selected");
      callbacks.current.onSelect(
        { at: page.dataset.at, text: "" },
        { text: false, locate: () => boxOf(page), user: true },
      );
    };
    const onUp = (event: Event) => setTimeout(() => report(event), 0);
    container.addEventListener("mouseup", onUp);
    container.addEventListener("keyup", onUp);
    return () => {
      container.removeEventListener("mouseup", onUp);
      container.removeEventListener("keyup", onUp);
    };
  }, [scrollRef, callbacks, revealRanges]);
}
