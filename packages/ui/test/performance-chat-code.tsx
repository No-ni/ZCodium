import "@/styles.css";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import {
  applyConversationFindHighlights,
  clearConversationFindHighlights,
} from "@/v4/conversationFindHighlightDom.js";
import type { ConversationFindMatch } from "@/v4/conversationFindIndex.js";
import type { Theme } from "@/useTheme.js";

const BLOCK_COUNT = 240;
const TARGET_MARKDOWN_LENGTH = 34_122;
const FIND_TEXT = "foo.bar";

function createMarkdown(): string {
  const blocks = Array.from({ length: BLOCK_COUNT }, (_, index) => {
    const label = String(index).padStart(3, "0");
    const findProbe = index === 0 ? `const findProbe = ${FIND_TEXT};\n` : "";
    const wrapProbe = index === 0 ? `const wrapProbe = "${"wide-line-".repeat(20)}";\n` : "";
    const prefix =
      `\`\`\`typescript\n` +
      `const block${label} = { index: ${index}, marker: "snippet-${label}" };\n` +
      findProbe +
      wrapProbe;
    const middle = "// fixture ";
    const suffix = "\n```\n\n";
    return { prefix, middle, suffix };
  });
  const fixedLength = blocks.reduce(
    (total, block) => total + block.prefix.length + block.middle.length + block.suffix.length,
    0,
  );
  const remaining = TARGET_MARKDOWN_LENGTH - fixedLength;
  if (remaining < 0) {
    throw new Error(`Fixture exceeds ${TARGET_MARKDOWN_LENGTH} characters`);
  }

  const baseFill = Math.floor(remaining / BLOCK_COUNT);
  const extraCharacters = remaining % BLOCK_COUNT;
  return blocks
    .map(
      (block, index) =>
        block.prefix +
        block.middle +
        "x".repeat(baseFill + (index < extraCharacters ? 1 : 0)) +
        block.suffix,
    )
    .join("");
}

const MARKDOWN = createMarkdown();
const markdownIndex = MARKDOWN.indexOf(FIND_TEXT);
const longTasks: number[] = [];
let mountStartedAt = 0;

if (typeof PerformanceObserver !== "undefined") {
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(entry.duration);
    });
    observer.observe({ type: "longtask", buffered: true });
  } catch {
    // Long task entries are optional in some Chromium builds.
  }
}

type TransitionMeasure = { name: string; commitMs: number };
type CapturedRange = {
  source: HTMLElement;
  textNode: Text;
  range: Range;
};

interface ChatCodeFixtureApi {
  ready: boolean;
  payloadLength: number;
  blockCount: number;
  measures: TransitionMeasure[];
  inputEvents: { key: string; type: "keydown" | "commit"; delayMs: number }[];
  startStreaming: () => void;
  completeStream: () => void;
  moveToHistory: () => void;
  moveToTail: () => void;
  setTheme: (theme: Theme) => void;
  replaceMarkdown: (markdown: string) => void;
  setFontSize: (size: number) => void;
  scrollToBlock: (index: number) => void;
  captureRange: () => { selectedText: string; sourceText: string };
  rangeState: () => {
    sameSource: boolean;
    sameTextNode: boolean;
    sameRange: boolean;
    rangeText: string;
    sourceConnected: boolean;
  };
  findMarker: () => {
    available: boolean;
    count: number;
    activeText: string;
    activeInSource: boolean;
  };
  clearFind: () => void;
  snapshot: () => Record<string, number | string | boolean>;
}

declare global {
  interface Window {
    performanceChatCode: ChatCodeFixtureApi;
  }
}

let capturedRange: CapturedRange | null = null;
const api: ChatCodeFixtureApi = {
  ready: false,
  payloadLength: MARKDOWN.length,
  blockCount: BLOCK_COUNT,
  measures: [],
  inputEvents: [],
  startStreaming: () => {},
  completeStream: () => {},
  moveToHistory: () => {},
  moveToTail: () => {},
  setTheme: () => {},
  replaceMarkdown: () => {},
  setFontSize: () => {},
  scrollToBlock: () => {},
  captureRange: () => ({ selectedText: "", sourceText: "" }),
  rangeState: () => ({
    sameSource: false,
    sameTextNode: false,
    sameRange: false,
    rangeText: "",
    sourceConnected: false,
  }),
  findMarker: () => ({ available: false, count: 0, activeText: "", activeInSource: false }),
  clearFind: () => {},
  snapshot: () => ({}),
};
Object.assign(window, { performanceChatCode: api });

function deepDOMSnapshot(root: Element) {
  const pending: ParentNode[] = [root];
  const visited = new Set<Element>();
  let elementCount = 0;
  let shadowRootCount = 0;
  let viewerContainerCount = 0;

  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const element of current.querySelectorAll("*")) {
      if (visited.has(element)) continue;
      visited.add(element);
      elementCount += 1;
      if (element.localName.startsWith("diffs-") || element.localName === "code-diff") {
        viewerContainerCount += 1;
      }
      if (element instanceof HTMLElement && element.style.getPropertyValue("--diffs-font-size")) {
        viewerContainerCount += 1;
      }
      if (element.shadowRoot) {
        shadowRootCount += 1;
        pending.push(element.shadowRoot);
      }
    }
  }
  return { elementCount, shadowRootCount, viewerContainerCount };
}

function InputProbe() {
  const [value, setValue] = useState("");
  const lastKey = useRef({ key: "", timeStamp: 0 });
  useLayoutEffect(() => {
    if (!value) return;
    api.inputEvents.push({
      key: lastKey.current.key,
      type: "commit",
      delayMs: performance.now() - lastKey.current.timeStamp,
    });
  }, [value]);
  return (
    <>
      <input
        aria-label="Responsiveness probe"
        className="w-24 min-w-0"
        value={value}
        onKeyDown={(event) => {
          lastKey.current = { key: event.key, timeStamp: event.timeStamp };
          api.inputEvents.push({
            key: event.key,
            type: "keydown",
            delayMs: performance.now() - event.timeStamp,
          });
          if (event.key === "Enter") {
            event.preventDefault();
            if (event.altKey) api.moveToHistory();
            else api.completeStream();
          }
        }}
        onChange={(event) => setValue(event.target.value)}
      />
      <output data-input-probe-echo>{value}</output>
    </>
  );
}

function Fixture() {
  const [markdown, setMarkdown] = useState(MARKDOWN);
  const [fontSizePx, setFontSize] = useState(DEFAULT_CODE_PREVIEW_SETTINGS.fontSizePx);
  const codeSettings = useMemo(
    () => ({ ...DEFAULT_CODE_PREVIEW_SETTINGS, fontSizePx }),
    [fontSizePx],
  );
  const [streaming, setStreaming] = useState(
    new URLSearchParams(window.location.search).get("mode") === "streaming",
  );
  const [theme, setTheme] = useState<Theme>("light");
  const [location, setLocation] = useState<"tail" | "history">("tail");
  const [measure, setMeasure] = useState<{ name: string; startedAt: number } | null>(null);
  const mounted = useRef(false);

  useLayoutEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      api.measures.push({ name: "cold-mount", commitMs: performance.now() - mountStartedAt });
      api.ready = true;
    }
    if (measure) {
      api.measures.push({ name: measure.name, commitMs: performance.now() - measure.startedAt });
      setMeasure(null);
    }
  }, [location, measure, streaming, theme]);

  const transition = (name: string, update: () => void) => {
    setMeasure({ name, startedAt: performance.now() });
    update();
  };

  Object.assign(api, {
    startStreaming: () => transition("streaming", () => setStreaming(true)),
    completeStream: () => transition("terminal", () => setStreaming(false)),
    moveToHistory: () => transition("history-reparent", () => setLocation("history")),
    moveToTail: () => transition("tail-reparent", () => setLocation("tail")),
    setTheme: (nextTheme: Theme) =>
      transition("theme", () => {
        document.documentElement.classList.toggle("dark", nextTheme === "dark");
        setTheme(nextTheme);
      }),
    scrollToBlock: (index: number) => {
      document
        .querySelectorAll<HTMLElement>("[data-code-snippet]")
        .item(index)
        ?.scrollIntoView({ block: "start" });
    },
    replaceMarkdown: (next: string) => setMarkdown(next),
    setFontSize,
    captureRange: () => {
      const source = document.querySelector<HTMLElement>("[data-code-snippet-source]");
      const textNode = source?.firstChild;
      if (!source || !(textNode instanceof Text)) return { selectedText: "", sourceText: "" };
      const start = textNode.data.indexOf(FIND_TEXT);
      if (start < 0) return { selectedText: "", sourceText: textNode.data };
      const range = document.createRange();
      range.setStart(textNode, start);
      range.setEnd(textNode, start + FIND_TEXT.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      capturedRange = { source, textNode, range };
      return { selectedText: selection?.toString() ?? "", sourceText: source.textContent ?? "" };
    },
    rangeState: () => {
      const selection = window.getSelection();
      return {
        sameSource:
          Boolean(capturedRange) &&
          document.querySelector("[data-code-snippet-source]") === capturedRange?.source,
        sameTextNode:
          Boolean(capturedRange) && capturedRange.source.firstChild === capturedRange.textNode,
        sameRange:
          Boolean(capturedRange) &&
          selection?.rangeCount === 1 &&
          selection.getRangeAt(0) === capturedRange?.range,
        rangeText: capturedRange?.range.toString() ?? "",
        sourceConnected: capturedRange?.source.isConnected ?? false,
      };
    },
    findMarker: () => {
      const root = document.getElementById("find-root");
      if (!root || markdownIndex < 0)
        return { available: false, count: 0, activeText: "", activeInSource: false };
      const match: ConversationFindMatch = {
        globalIndex: 0,
        unitIndex: 0,
        rowId: 1,
        rowKind: "assistantText",
        rowMatchIndex: 0,
        start: markdownIndex,
        end: markdownIndex + FIND_TEXT.length,
        sourceText: MARKDOWN,
      };
      const range = applyConversationFindHighlights({
        root,
        query: FIND_TEXT,
        matches: [match],
        activeMatch: match,
      });
      const registry = (CSS as unknown as { highlights?: Map<string, Set<Range>> }).highlights;
      return {
        available: Boolean(registry),
        count: registry?.get("zcode-v4-conversation-find")?.size ?? 0,
        activeText: range?.toString() ?? "",
        activeInSource: Boolean(
          range?.startContainer.parentElement?.closest("[data-code-snippet-source]"),
        ),
      };
    },
    clearFind: () => clearConversationFindHighlights(),
    snapshot: () => {
      const root = document.getElementById("message-scroll");
      if (!root) return {};
      const deep = deepDOMSnapshot(root);
      const snippets = [...root.querySelectorAll<HTMLElement>("[data-code-snippet]")];
      const viewport = root.getBoundingClientRect();
      const highlightedOffscreen = snippets.filter((snippet) => {
        if (!snippet.querySelector("[data-code-snippet-highlight]")) return false;
        const rect = snippet.getBoundingClientRect();
        return rect.bottom <= viewport.top || rect.top >= viewport.bottom;
      }).length;
      return {
        codeBlocks: root.querySelectorAll('[data-language="typescript"]').length,
        snippets: snippets.length,
        sourceElements: root.querySelectorAll("[data-code-snippet-source]").length,
        highlights: root.querySelectorAll("[data-code-snippet-highlight]").length,
        highlightedOffscreen,
        ...deep,
        longTaskCount: longTasks.length,
        longTaskTotalMs: longTasks.reduce((total, duration) => total + duration, 0),
        longTaskMaxMs: Math.max(0, ...longTasks),
        scrollHeight: Math.round(root.scrollHeight),
      };
    },
  });

  const row = (
    <div id="message-row" data-row-id="1">
      <MessageResponse codePreviewSettings={codeSettings} streaming={streaming} theme={theme}>
        {markdown}
      </MessageResponse>
    </div>
  );

  return (
    <>
      <style>{`
        #fixture-shell { display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; }
        #fixture-controls { display: flex; flex: 0 0 auto; align-items: center; gap: 8px; padding: 8px; border-bottom: 1px solid #8884; }
        #message-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 8px; }
        #find-root { width: 100%; }
        #message-row { width: min(100%, 900px); margin: 0 auto; }
      `}</style>
      <main id="fixture-shell">
        <div id="fixture-controls" data-ready={String(api.ready)}>
          <InputProbe />
          <span>mode: {streaming ? "streaming" : "complete"}</span>
          <span>location: {location}</span>
        </div>
        <div id="message-scroll">
          <div id="find-root">
            <div id="live-tail-root">{location === "tail" ? row : null}</div>
            <div id="history-root">{location === "history" ? row : null}</div>
          </div>
        </div>
      </main>
    </>
  );
}

mountStartedAt = performance.now();
createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale="en-US">
    <TooltipProvider>
      <Fixture />
    </TooltipProvider>
  </ZCodeIntlProvider>,
);
