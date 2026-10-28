import { readBinary, readText } from "#ui/assets.ts";
import * as pdfjs from "pdfjs-dist";
import type { PDFPageProxy } from "pdfjs-dist";
import { normalizeCjkCompat } from "#office/domain/cjk.ts";
import { canvasToPng } from "#ui/raster.ts";

/** pdf.js workers/cMaps/font/WASM have one local resource port, never a network fetch. */
export class AssetCMapFactory {
  constructor(private readonly options: { baseUrl: string | null; isCompressed: boolean }) {}
  async fetch({ name }: { name: string }) {
    return {
      cMapData: await readBinary(`${this.options.baseUrl}${name}.bcmap`),
      isCompressed: true,
    };
  }
}
export class AssetBinaryFactory {
  constructor(private readonly options: { baseUrl: string | null }) {}
  async fetch({ filename }: { filename: string }) {
    return readBinary(`${this.options.baseUrl}${filename}`);
  }
}
let sharedWorker: Promise<pdfjs.PDFWorker> | undefined;
export function worker(): Promise<pdfjs.PDFWorker> {
  return (sharedWorker ??= readText("pdf-worker.js").then((source) => {
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    return pdfjs.PDFWorker.create({ port: new Worker(url, { type: "module" }) });
  }));
}
export async function pageTextContent(page: PDFPageProxy) {
  const content = await page.getTextContent();
  return {
    ...content,
    items: content.items.map((item) =>
      "str" in item ? { ...item, str: normalizeCjkCompat(item.str) } : item,
    ),
  };
}
export interface PageSlot {
  element: HTMLDivElement;
  done?: Promise<void>;
  task?: { cancel(): void };
  textLayer?: HTMLDivElement;
}
export async function rasterPage(page: PDFPageProxy, width: number, ratio = 1) {
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.min(3, width / base.width) * ratio });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  return canvas;
}
export async function capturePdfPage(page: PDFPageProxy, maxWidth: number) {
  return canvasToPng(await rasterPage(page, maxWidth), maxWidth);
}
