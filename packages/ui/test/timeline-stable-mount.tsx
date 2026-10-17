// 真实时间线的隔离夹具：只消费合成 rows，不连接 Host、Agent 或用户数据。
import "@/styles.css";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ConversationRow, SessionPhase, TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ConversationTimeline } from "@/v4/ConversationTimeline.js";
import type { ConversationFindMatchState } from "@/v4/legacyChatViewTypes.js";

type TerminalState = Exclude<TurnHeaderRow["state"], "running">;
const api = {
  revision: 0,
  find: { matchCount: 0 } as ConversationFindMatchState,
  reset: (_count = 40) => {},
  complete: (_state: TerminalState) => {},
  grow: () => {},
  next: () => {},
  prepend: () => {},
  epoch: () => {},
  session: () => {},
  rewind: () => {},
  ordinaryStream: () => {},
  resume: () => {},
  jump: (_turn: number) => {},
  bottom: () => {},
  search: (_query: string) => {},
  capture: (_turn: number) => {},
  identity: () => ({}),
};
Object.assign(window, { timelineFixture: api });

const CODE = `\n\n\`\`\`typescript\nconst stableMountProbe = "${"long-code-line ".repeat(30)}";\n\`\`\``;
function turnRows(turn: number, running: boolean): ConversationRow[] {
  const base = {
    turnId: `turn-${turn}`,
    productTurnId: `turn-${turn}`,
    createdAt: 1_700_000_000_000 + turn,
    createdAtSeq: turn,
  };
  return [
    {
      ...base,
      kind: "turnHeader",
      rowId: turn * 4,
      entityId: `header-${turn}`,
      origin: "userInput",
      state: running ? "running" : "completedSuccess",
      startedAt: base.createdAt,
      ...(running ? {} : { endedAt: base.createdAt + 1000, activeMs: 1000 }),
    },
    {
      ...base,
      kind: "userInput",
      rowId: turn * 4 + 1,
      entityId: `query-${turn}`,
      origin: "realUser",
      text: `query stable ${turn}`,
    },
    {
      ...base,
      kind: "assistantText",
      rowId: turn * 4 + 2,
      entityId: `answer-${turn}`,
      assistantResponseId: `response-${turn}`,
      state: running ? "streaming" : "complete",
      actions: { canFork: true },
      text: `answer stable ${turn}\n\n${"Synthetic timeline paragraph. ".repeat(12)}` + CODE,
    },
  ];
}

function initialRows(count: number) {
  return Array.from({ length: count }, (_, i) => turnRows(100 + i, i === count - 1)).flat();
}

let captured: {
  wrapper: Element;
  group: Element | null;
  query: Element | null;
  body: Element | null;
  parent: Element | null;
  removed: number;
  observer: MutationObserver;
} | null = null;
api.capture = (turn) => {
  captured?.observer.disconnect();
  const wrapper = document.querySelector(`[data-v4-turn-unit][data-turn-id="turn-${turn}"]`)!;
  if (!wrapper) throw new Error(`Turn ${turn} is not mounted`);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const removed of record.removedNodes) {
        if (removed === wrapper || removed.contains(wrapper)) captured!.removed++;
      }
    }
  });
  captured = {
    wrapper,
    group: wrapper.querySelector("[data-turn-key]"),
    query: wrapper.querySelector(`[data-row-id="${turn * 4 + 1}"]`),
    body: wrapper.querySelector(`[data-row-id="${turn * 4 + 2}"]`),
    parent: wrapper.parentElement,
    removed: 0,
    observer,
  };
  observer.observe(document.getElementById("root")!, { childList: true, subtree: true });
};
api.identity = () => {
  if (!captured) throw new Error("Capture a mounted turn first");
  const id = captured.wrapper.getAttribute("data-turn-id");
  const current = document.querySelector(`[data-v4-turn-unit][data-turn-id="${id}"]`);
  return {
    sameWrapper: current === captured.wrapper,
    sameGroup: current?.querySelector("[data-turn-key]") === captured.group,
    sameQuery: !!captured.query && captured.query.isConnected,
    sameBody: !!captured.body && captured.body.isConnected,
    sameParent: current?.parentElement === captured.parent,
    removed: captured.removed,
    live: current?.hasAttribute("data-v4-running-live-tail") ?? false,
  };
};

function Fixture() {
  const [rows, setRows] = useState(() => initialRows(40));
  const [phase, setPhase] = useState<SessionPhase>("running");
  const [epoch, setEpoch] = useState(0);
  const [session, setSession] = useState(0);
  const [query, setQuery] = useState("");
  const bottom = useRef<(() => void) | null>(null);
  const jump = useRef<((target: { unitIndex: number; rowId: number }) => void) | null>(null);
  const context = useMemo(
    () => ({
      logEpoch: `epoch-${epoch}`,
      workspacePath: "C:/synthetic-timeline",
      sessionId: `synthetic-${session}`,
      theme: "zai-light" as const,
      codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
    }),
    [epoch, session],
  );
  useLayoutEffect(() => {
    api.revision++;
    api.reset = (count = 40) => {
      setRows(initialRows(count));
      setPhase("running");
      setQuery("");
      setSession((value) => value + 1);
    };
    api.complete = (state) => {
      const lastTurn = rows.at(-1)?.turnId;
      setRows((current) =>
        current.map((row): ConversationRow => {
          if (row.turnId !== lastTurn) return row;
          if (row.kind === "turnHeader")
            return { ...row, state, endedAt: row.createdAt + 1000, activeMs: 1000 };
          if (row.kind === "assistantText")
            return {
              ...row,
              state:
                state === "completedSuccess"
                  ? "complete"
                  : state === "failed"
                    ? "failed"
                    : "interrupted",
            };
          return row;
        }),
      );
      setPhase(state === "failed" ? "error" : state);
    };
    api.grow = () =>
      setRows((current) =>
        current.map((row, i) =>
          i === current.length - 1 && row.kind === "assistantText"
            ? { ...row, text: row.text + "\n\nStreaming growth. ".repeat(35) }
            : row,
        ),
      );
    api.next = () => {
      const nextTurn = Math.floor(rows.at(-1)!.rowId / 4) + 1;
      setRows((current) => [...current, ...turnRows(nextTurn, true)]);
      setPhase("running");
    };
    api.prepend = () => {
      const first = Math.floor(rows[0]!.rowId / 4);
      setRows((current) => [
        ...Array.from({ length: 10 }, (_, i) => turnRows(first - 10 + i, false)).flat(),
        ...current,
      ]);
    };
    api.epoch = () => setEpoch((value) => value + 1);
    api.session = () => setSession((value) => value + 1);
    api.rewind = () => {
      setRows((current) => current.slice(0, -3));
      setPhase("completedSuccess");
    };
    api.ordinaryStream = () =>
      setRows((current) =>
        current.map((row, index) =>
          index === current.length - 1 && row.kind === "assistantText"
            ? { ...row, actions: undefined }
            : row,
        ),
      );
    api.resume = () => {
      const turnId = rows.at(-1)!.turnId;
      setRows((current) =>
        current.map((row): ConversationRow => {
          if (row.turnId !== turnId) return row;
          if (row.kind === "turnHeader") return { ...row, state: "running", endedAt: undefined };
          if (row.kind === "assistantText") return { ...row, state: "streaming" };
          return row;
        }),
      );
      setPhase("running");
    };
    api.bottom = () => bottom.current?.();
    api.jump = (turn) => {
      const first = Math.floor(rows[0]!.rowId / 4);
      jump.current?.({ unitIndex: turn - first, rowId: turn * 4 + 1 });
    };
    api.search = setQuery;
  });
  return (
    <main id="fixture-shell">
      <ConversationTimeline
        rows={rows}
        totalCount={rows.length}
        sessionKey={`synthetic-${session}`}
        sessionPhase={phase}
        rowContext={context}
        headerSlot={<div style={{ height: 140 }}>Synthetic shared history header</div>}
        bottomDock={
          <textarea aria-label="Synthetic composer" rows={2} className="w-full bg-background" />
        }
        scrollToBottomActionRef={bottom}
        scrollToQueryActionRef={jump}
        conversationFindQuery={query}
        conversationFindActiveIndex={query ? 0 : -1}
        onConversationFindMatchStateChange={(state: ConversationFindMatchState) => {
          api.find = state;
        }}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale="en-US">
    <TooltipProvider>
      <Fixture />
    </TooltipProvider>
  </ZCodeIntlProvider>,
);
