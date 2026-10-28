import type { PDFDocumentProxy } from "pdfjs-dist";
import type { ShowTarget } from "#office/contract.ts";
import { parseLocator } from "#office/domain/anchor.ts";
import {
  boxOf,
  countMatches,
  findAllRanges,
  findTextRange,
  paintRanges,
  scrollToRange,
} from "#ui/dom.ts";
import type { PageSlot } from "#ui/viewers/pdfAssets.ts";
import type { RevealedTarget } from "#ui/viewers/types.ts";

export interface PdfMarksPorts {
  document(): PDFDocumentProxy | null;
  pages(): PageSlot[];
  scroll(): HTMLDivElement | null;
  rendered(page: number): Promise<PageSlot | null>;
  text(page: number): Promise<string>;
  scrollToPage(page: number): void;
}
interface RevealItem {
  page: number;
  to: number;
  quote?: string;
}
interface FindState {
  query: string;
  matches: { page: number; k: number }[];
  current: number;
  ranges: Map<number, Range[]>;
}

/** One local owner for PDF reveal/find marks; it never accepts session or workspace state. */
export function createPdfMarks(ports: PdfMarksPorts) {
  let revealItems: RevealItem[] = [];
  let revealTicket = 0;
  let findState: FindState | null = null;
  const revealRanges = { current: new Map<number, Range>() };
  const pageTexts = new Map<number, Promise<string>>();

  function currentFindRange(): Range | null {
    const match = findState?.matches[findState.current];
    if (!findState || !match) return null;
    const ranges = findState.ranges.get(match.page) ?? [];
    return ranges[Math.min(match.k, ranges.length - 1)] ?? null;
  }
  function paint() {
    paintRanges("office-reveal", [...revealRanges.current.values()]);
    const current = currentFindRange();
    paintRanges(
      "office-find",
      [...(findState?.ranges.values() ?? [])].flat().filter((range) => range !== current),
    );
    paintRanges("office-find-current", current ? [current] : []);
  }
  function decorate(page: number) {
    const layer = ports.pages()[page - 1]?.textLayer;
    if (!layer) return;
    revealItems.forEach((item, i) => {
      if (!item.quote || item.page !== page) return;
      const current = revealRanges.current.get(i);
      if (current && layer.contains(current.startContainer)) return;
      const range = findTextRange(layer, item.quote);
      if (range) revealRanges.current.set(i, range);
      else revealRanges.current.delete(i);
    });
    if (findState?.query) findState.ranges.set(page, findAllRanges(layer, findState.query));
    paint();
  }
  function clearReveal() {
    ++revealTicket;
    revealItems = [];
    revealRanges.current.clear();
    for (const slot of ports.pages()) slot.element.classList.remove("revealed");
    paint();
  }
  function clearFind() {
    findState = null;
    paint();
  }
  function resize() {
    revealRanges.current.clear();
    findState?.ranges.clear();
    paint();
  }
  function reset() {
    clearReveal();
    clearFind();
    pageTexts.clear();
  }

  async function reveal(targets: ShowTarget[]): Promise<RevealedTarget[]> {
    clearReveal();
    const ticket = revealTicket;
    const doc = ports.document();
    // 切文档或清除高亮后，旧 text-layer Promise 不得重新写入已失效的选区。
    const valid = () => ticket === revealTicket && ports.document() === doc;
    const items: RevealItem[] = [];
    for (const target of targets) {
      const locator = parseLocator("pdf", target.at);
      if (locator.kind !== "pdf" || !ports.pages()[locator.from - 1]) continue;
      items.push({
        page: locator.from,
        to: locator.to,
        ...(target.quote ? { quote: target.quote } : {}),
      });
    }
    revealItems = items;
    for (const [i, item] of items.entries()) {
      if (!item.quote) {
        for (let n = item.page; n <= item.to; n++)
          ports.pages()[n - 1]?.element.classList.add("revealed");
        continue;
      }
      for (let n = item.page; n <= item.to; n++) {
        const slot = await ports.rendered(n);
        if (!valid()) return [];
        const range = slot?.textLayer && findTextRange(slot.textLayer, item.quote);
        if (range) {
          item.page = n;
          revealRanges.current.set(i, range);
          break;
        }
      }
    }
    if (!valid()) return [];
    paint();
    const results = items.map(
      (item, i): RevealedTarget => ({
        at:
          item.to > item.page && !item.quote ? `page:${item.page}-${item.to}` : `page:${item.page}`,
        locate: () =>
          valid()
            ? (boxOf(revealRanges.current.get(i)) ?? boxOf(ports.pages()[item.page - 1]?.element))
            : null,
        scrollTo() {
          if (!valid()) return;
          const range = revealRanges.current.get(i);
          if (range?.startContainer.isConnected) scrollToRange(range, "upper");
          else if (item.quote)
            void ports.rendered(item.page).then(() => {
              if (!valid()) return;
              decorate(item.page);
              const again = revealRanges.current.get(i);
              if (again) scrollToRange(again, "upper");
              else ports.scrollToPage(item.page);
            });
          else ports.scrollToPage(item.page);
        },
      }),
    );
    results[0]?.scrollTo();
    return results;
  }

  async function find(query: string): Promise<number> {
    const doc = ports.document();
    if (!doc || !query.trim()) {
      clearFind();
      return 0;
    }
    const state: FindState = { query, matches: [], current: -1, ranges: new Map() };
    findState = state;
    const counts = await Promise.all(
      Array.from({ length: doc.numPages }, (_, i) => {
        let text = pageTexts.get(i + 1);
        if (!text) {
          text = ports.text(i + 1);
          pageTexts.set(i + 1, text);
        }
        return text.then((value) => countMatches(value, query));
      }),
    );
    // 查找结果属于开始时的文档和查找对象，不能在切文档/新查找之后提交。
    if (findState !== state || ports.document() !== doc) return 0;
    counts.forEach((count, i) => {
      for (let k = 0; k < count; k++) state.matches.push({ page: i + 1, k });
    });
    for (const [i, slot] of ports.pages().entries())
      if (slot.textLayer) state.ranges.set(i + 1, findAllRanges(slot.textLayer, query));
    paint();
    return state.matches.length;
  }
  function findGo(index: number) {
    const state = findState;
    const match = state?.matches[index];
    const doc = ports.document();
    if (!state || !match) return;
    state.current = index;
    void ports.rendered(match.page).then(() => {
      if (findState !== state || state.current !== index || ports.document() !== doc) return;
      if (!state.ranges.has(match.page)) decorate(match.page);
      paint();
      const range = currentFindRange();
      if (range) scrollToRange(range, "center");
      else ports.scrollToPage(match.page);
    });
    paint();
  }
  return {
    revealRanges,
    reveal,
    clearReveal,
    find,
    findGo,
    clearFind,
    paint,
    decorate,
    resize,
    reset,
  };
}
