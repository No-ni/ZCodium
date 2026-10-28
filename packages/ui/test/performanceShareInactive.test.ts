import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { ConversationRow, ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { buildConversationTurnRenderUnits } from "@/v4/conversationTurnRenderUnits.js";
import { buildConversationTurnNavigatorItems } from "@/v4/conversationTurnNavigatorHelpers.js";
import {
  getConversationShareSelectedRowIds,
  getConversationShareSelectedProductTurnIds,
  useConversationShareSelectionStore,
} from "@/store/conversationShareSelectionStore.js";
import { readShareDerivationBody } from "./performanceShareInactive.source.js";

const options = {
  assistantEmptyPreview: "empty",
  assistantRunningPreview: "running",
  userFallbackPreview: "user",
};
const intl = {
  formatMessage: ({ id }: { id: string }) =>
    ({
      "chat.turnNavigator.emptyAssistant": options.assistantEmptyPreview,
      "chat.turnNavigator.runningAssistant": options.assistantRunningPreview,
      "chat.turnNavigator.userFallback": options.userFallbackPreview,
    })[id],
};
type Memo = (build: () => unknown, dependencies: readonly unknown[]) => unknown;
let derive: (active: boolean, rows: ConversationRow[], memo?: Memo) => ReturnType<typeof baseline>;

function baseline(rows: ConversationRow[]) {
  const shareRenderUnits = buildConversationTurnRenderUnits(rows);
  const shareItems = buildConversationTurnNavigatorItems(shareRenderUnits, options);
  const eligibleShareItems = shareItems.filter((item) => !item.isRunning);
  const eligibleShareRowIds = new Set(eligibleShareItems.map((item) => item.rowId));
  const rowsById = new Map(rows.map((row) => [row.rowId, row]));
  const seen = new Set<string>();
  const eligibleShareProductTurnIds = eligibleShareItems.flatMap((item) => {
    const id = rowsById.get(item.rowId)?.productTurnId;
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [id];
  });
  return {
    shareRenderUnits,
    shareItems,
    eligibleShareItems,
    eligibleShareRowIds,
    eligibleShareProductTurnIds,
  };
}

function turn(id: number, running = false, text = `answer ${id}`): ConversationRow[] {
  const base = { turnId: `t${id}`, productTurnId: `p${id}`, createdAt: 100, createdAtSeq: id };
  return [
    {
      ...base,
      rowId: id * 3,
      kind: "turnHeader",
      executionKind: "agent",
      state: running ? "running" : "completedSuccess",
      startedAt: 100,
      ...(running ? {} : { endedAt: 300 }),
    },
    { ...base, rowId: id * 3 + 1, kind: "userInput", origin: "realUser", text: `query ${id}` },
    {
      ...base,
      rowId: id * 3 + 2,
      kind: "assistantText",
      text,
      state: running ? "streaming" : "complete",
    },
  ] as ConversationRow[];
}

beforeAll(async () => {
  const body = await readShareDerivationBody();
  const run = new Function(
    "shareActive",
    "snapshot",
    "useMemo",
    "buildConversationTurnRenderUnits",
    "buildConversationTurnNavigatorItems",
    "intl",
    body,
  );
  derive = (active, rows, memo = (build) => build()) =>
    run(
      active,
      { rows: { window: rows } } as ConversationSnapshot,
      memo,
      buildConversationTurnRenderUnits,
      buildConversationTurnNavigatorItems,
      intl,
    );
});
beforeEach(() => useConversationShareSelectionStore.getState().resetForTests());

function render(sessionId: string, rows: ConversationRow[]) {
  const state = useConversationShareSelectionStore.getState();
  const active = state.drafts[sessionId]?.scope === "partial";
  const result = derive(active, rows);
  if (active) {
    const rowsById = new Map(rows.map((row) => [row.rowId, row]));
    state.syncAvailableTurns(
      sessionId,
      result.eligibleShareItems.flatMap((item) => {
        const productTurnId = rowsById.get(item.rowId)?.productTurnId;
        return productTurnId ? [{ rowId: item.rowId, productTurnId }] : [];
      }),
    );
  }
  return result;
}

function selected(sessionId: string) {
  return getConversationShareSelectedRowIds(
    useConversationShareSelectionStore.getState(),
    sessionId,
  );
}

describe("SessionPane inactive share derivation", () => {
  it("renders the actual browser fixture with its shared tooltip root", async () => {
    let content: ReactNode;
    const root = {
      render: vi.fn((node: ReactNode) => {
        content = node;
      }),
    };
    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    vi.doMock("react-dom/client", () => ({ createRoot: () => root }));
    vi.stubGlobal("document", { getElementById: () => ({}) });
    vi.stubGlobal("window", { shareDerivation: () => derive(false, []) });
    try {
      await import("./performance-share-inactive.js");
      expect(root.render).toHaveBeenCalledOnce();
      const html = renderToStaticMarkup(content);
      expect(html).toContain('data-testid="conversation-share-trigger"');
      expect(html).toContain('aria-label="Share status"');
      expect(html).toContain("&quot;active&quot;:false");
      expect(html).toContain("&quot;rowReads&quot;:0");
      expect(html).toContain("&quot;textReads&quot;:0");
    } finally {
      vi.doUnmock("react-dom/client");
      vi.stubGlobal("window", originalWindow);
      vi.stubGlobal("document", originalDocument);
    }
  });

  it("does not inspect history rows or text while sharing is inactive", () => {
    let rowReads = 0;
    let textReads = 0;
    const rows = Array.from({ length: 1000 }, (_, id) => turn(id)).flat();
    for (const row of rows) {
      const rowId = row.rowId;
      Object.defineProperty(row, "rowId", {
        get() {
          rowReads++;
          return rowId;
        },
      });
      if (row.kind === "assistantText") {
        const text = row.text;
        Object.defineProperty(row, "text", {
          get() {
            textReads++;
            return text;
          },
        });
      }
    }
    for (let update = 0; update < 3; update++) {
      render("a", [...rows]);
    }
    expect({ rowReads, textReads }).toEqual({ rowReads: 0, textReads: 0 });
    expect(useConversationShareSelectionStore.getState().drafts.a).toBeUndefined();
  });

  it("keeps inactive memo references stable and recomputes from current rows on reopen", () => {
    const slots: Array<{ dependencies: readonly unknown[]; value: unknown }> = [];
    let cursor = 0;
    const memo: Memo = (build, dependencies) => {
      const index = cursor++;
      const previous = slots[index];
      if (
        previous &&
        previous.dependencies.length === dependencies.length &&
        dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))
      )
        return previous.value;
      const value = build();
      slots[index] = { dependencies: [...dependencies], value };
      return value;
    };
    const update = (active: boolean, rows: ConversationRow[]) => {
      cursor = 0;
      return derive(active, rows, memo);
    };
    const closed = update(false, turn(1));
    for (const rows of [turn(2), [...turn(1), ...turn(3)], turn(1, false, "replacement")]) {
      const next = update(false, rows);
      for (const key of Object.keys(closed) as Array<keyof typeof closed>)
        expect(next[key]).toBe(closed[key]);
    }
    const opened = update(true, turn(1, false, "fresh answer"));
    expect(opened).toEqual(baseline(turn(1, false, "fresh answer")));
    expect(opened.shareItems).not.toBe(closed.shareItems);
    const closedAgain = update(false, turn(1));
    expect(closedAgain.shareItems).toEqual([]);
    const latest = [...turn(1, false, "latest answer"), ...turn(2)];
    expect(update(false, latest).shareItems).toBe(closedAgain.shareItems);
    const reopened = update(true, latest);
    expect(reopened).toEqual(baseline(latest));
    expect(reopened.shareItems).not.toBe(opened.shareItems);
  });

  it("keeps the original complete active output for streaming, rewind and same-ID replacements", () => {
    for (const rows of [
      [],
      turn(1),
      [...turn(1), ...turn(2, true)],
      [...turn(1), ...turn(2, true, "ab")],
      [...turn(1), ...turn(2)],
      turn(1, false, "replacement"),
    ]) {
      expect(derive(true, rows)).toEqual(baseline(rows));
    }
  });

  it("preserves first-open timeline selection, configuration, close and reopen defaults", () => {
    const store = useConversationShareSelectionStore.getState();
    let rows = [...turn(1), ...turn(2, true)];
    store.setScope("a", "partial");
    store.showTimeline("a");
    expect(render("a", rows)).toEqual(baseline(rows));
    expect(useConversationShareSelectionStore.getState().drafts.a?.view).toBe("timeline");
    expect(selected("a")).toEqual([4]);
    store.toggleRow("a", 4);
    rows = [...turn(1), ...turn(2, true, "stream update")];
    render("a", rows);
    expect(selected("a")).toEqual([]);
    store.showSelectionPanel("a");
    store.setAllRowsSelected("a", true);
    store.goToConfiguration("a");
    expect(render("a", rows)).toEqual(baseline(rows));
    expect(useConversationShareSelectionStore.getState().drafts.a?.stage).toBe("configuration");
    rows = [...turn(1), ...turn(2)];
    render("a", rows);
    expect(selected("a")).toEqual([4, 7]);
    expect(
      getConversationShareSelectedProductTurnIds(
        useConversationShareSelectionStore.getState(),
        "a",
      ),
    ).toEqual(["p1", "p2"]);
    store.deselectProductTurn("a", "p1");
    expect(selected("a")).toEqual([7]);
    store.finishSelection("a");
    expect(render("a", [...rows, ...turn(3)]).shareItems).toEqual([]);
    expect(selected("a")).toEqual([]);
    store.setScope("a", "partial");
    store.showTimeline("a");
    render("a", [...rows, ...turn(3)]);
    expect(selected("a")).toEqual([4, 7, 10]);
  });

  it("keeps independent session drafts and does not sync an inactive session", () => {
    const store = useConversationShareSelectionStore.getState();
    store.setScope("a", "partial");
    render("a", turn(1));
    store.toggleRow("a", 4);
    expect(render("b", turn(9)).shareItems).toEqual([]);
    expect(useConversationShareSelectionStore.getState().drafts.b).toBeUndefined();
    store.setScope("b", "partial");
    render("b", turn(9));
    expect(selected("b")).toEqual([28]);
    expect(selected("a")).toEqual([]);
  });
});
