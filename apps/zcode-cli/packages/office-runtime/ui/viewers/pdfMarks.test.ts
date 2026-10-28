import { describe, expect, it, vi } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { createPdfMarks, type PdfMarksPorts } from "#ui/viewers/pdfMarks.ts";

vi.mock("#ui/dom.ts", () => ({
  boxOf: () => null,
  countMatches: (text: string, query: string) => text.split(query).length - 1,
  findAllRanges: () => [],
  findTextRange: () => ({}) as Range,
  paintRanges: vi.fn(),
  scrollToRange: vi.fn(),
}));

function fixture() {
  let doc = { numPages: 1 } as PDFDocumentProxy;
  const element = {
    classList: { add: vi.fn(), remove: vi.fn() },
  } as unknown as HTMLDivElement;
  const slot = { element, textLayer: {} as HTMLDivElement };
  const ports: PdfMarksPorts = {
    document: () => doc,
    pages: () => [slot],
    scroll: () => null,
    rendered: async () => slot,
    text: async () => "Revenue Revenue",
    scrollToPage: vi.fn(),
  };
  return {
    ports,
    slot,
    replaceDocument() {
      doc = { numPages: 1 } as PDFDocumentProxy;
    },
  };
}

describe("PDF local marks admission", () => {
  it("cannot restore a quote after clearReveal while its text layer is loading", async () => {
    const { ports, slot } = fixture();
    let release!: () => void;
    ports.rendered = () =>
      new Promise((resolve) => {
        release = () => resolve(slot);
      });
    const marks = createPdfMarks(ports);
    const pending = marks.reveal([{ at: "page:1", quote: "Revenue" }]);
    marks.clearReveal();
    release();
    expect(await pending).toEqual([]);
    expect(marks.revealRanges.current.size).toBe(0);
  });

  it("drops a pending search when its document has changed", async () => {
    const f = fixture();
    let release!: () => void;
    f.ports.text = () =>
      new Promise((resolve) => {
        release = () => resolve("Revenue");
      });
    const marks = createPdfMarks(f.ports);
    const pending = marks.find("Revenue");
    f.replaceDocument();
    marks.reset();
    release();
    expect(await pending).toBe(0);
  });

  it("counts matches and clears the same owner before the next search", async () => {
    const { ports } = fixture();
    const marks = createPdfMarks(ports);
    expect(await marks.find("Revenue")).toBe(2);
    marks.clearFind();
    marks.findGo(0);
    expect(ports.scrollToPage).not.toHaveBeenCalled();
    expect(await marks.find("")).toBe(0);
  });
});
