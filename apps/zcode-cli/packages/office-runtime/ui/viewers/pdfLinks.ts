import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { scrollToElement } from "#ui/dom.ts";
import type { PageSlot } from "#ui/viewers/pdfAssets.ts";

/** Only internal PDF destinations are clickable; URL actions are never routed to the host. */
export async function addPdfLinks(
  page: PDFPageProxy,
  viewport: ReturnType<PDFPageProxy["getViewport"]>,
  layer: HTMLDivElement,
  doc: PDFDocumentProxy,
  slots: readonly PageSlot[],
) {
  for (const annotation of await page.getAnnotations({ intent: "display" })) {
    if (annotation.subtype !== "Link" || !annotation.dest || annotation.url || annotation.unsafeUrl)
      continue;
    const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(annotation.rect);
    const link = document.createElement("a");
    link.className = "pdf-link";
    link.style.left = `${Math.min(x1, x2)}px`;
    link.style.top = `${Math.min(y1, y2)}px`;
    link.style.width = `${Math.abs(x2 - x1)}px`;
    link.style.height = `${Math.abs(y2 - y1)}px`;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void (async () => {
        const explicit =
          typeof annotation.dest === "string"
            ? await doc.getDestination(annotation.dest)
            : annotation.dest;
        const target = Array.isArray(explicit) ? explicit[0] : null;
        const number =
          target && typeof target === "object"
            ? await doc.getPageIndex(target)
            : typeof target === "number"
              ? target
              : -1;
        const slot = slots[number];
        if (slot?.element.isConnected) scrollToElement(slot.element, "start");
      })().catch(() => undefined);
    });
    layer.append(link);
  }
}
