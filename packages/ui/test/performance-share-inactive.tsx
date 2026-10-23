import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { ConversationShareMenu } from "@/ConversationShareMenu.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ConversationShareSelectionPanel } from "@/v4/ConversationShareSelectionPanel.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { buildConversationTurnRenderUnits } from "@/v4/conversationTurnRenderUnits.js";
import { buildConversationTurnNavigatorItems } from "@/v4/conversationTurnNavigatorHelpers.js";
import {
  getConversationShareSelectedRowIds,
  useConversationShareSelectionStore,
} from "@/store/conversationShareSelectionStore.js";

declare global {
  interface Window {
    shareDerivation: (...args: unknown[]) => {
      shareItems: ReturnType<typeof buildConversationTurnNavigatorItems>;
      eligibleShareItems: ReturnType<typeof buildConversationTurnNavigatorItems>;
      eligibleShareProductTurnIds: string[];
    };
  }
}
const sessionId = "synthetic-share-session";
const intl = {
  formatMessage: ({ id }: { id: string }) =>
    ({
      "chat.turnNavigator.emptyAssistant": "empty",
      "chat.turnNavigator.runningAssistant": "running",
      "chat.turnNavigator.userFallback": "user",
    })[id],
};
let rowReads = 0;
let textReads = 0;
function turn(id: number, running = false, answer = `answer ${id}`): ConversationRow[] {
  const base = { turnId: `t${id}`, productTurnId: `p${id}`, createdAt: 100, createdAtSeq: id };
  const rows = [
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
      text: answer,
      state: running ? "streaming" : "complete",
    },
  ] as ConversationRow[];
  for (const row of rows) {
    const rowId = row.rowId;
    Object.defineProperty(row, "rowId", {
      get() {
        rowReads++;
        return rowId;
      },
    });
    if (row.kind === "assistantText")
      Object.defineProperty(row, "text", {
        get() {
          textReads++;
          return answer;
        },
      });
  }
  return rows;
}
function Fixture() {
  const [rows, setRows] = useState(() => [...turn(1), ...turn(2, true)]);
  const [revision, setRevision] = useState(0);
  const draft = useConversationShareSelectionStore((state) => state.drafts[sessionId]);
  const active = draft?.scope === "partial";
  // 由服务器从当前 SessionPane AST 注入，不维护独立优化版本；真实 useMemo 验证空输入稳定性。
  const result = window.shareDerivation(
    active,
    { rows: { window: rows } },
    useMemo,
    buildConversationTurnRenderUnits,
    buildConversationTurnNavigatorItems,
    intl,
  );
  useEffect(() => {
    if (!active) return;
    const rowsById = new Map(rows.map((row) => [row.rowId, row]));
    useConversationShareSelectionStore.getState().syncAvailableTurns(
      sessionId,
      result.eligibleShareItems.flatMap((item) => {
        const productTurnId = rowsById.get(item.rowId)?.productTurnId;
        return productTurnId ? [{ rowId: item.rowId, productTurnId }] : [];
      }),
    );
  }, [active, rows, result.eligibleShareItems]);
  const selected = new Set(
    getConversationShareSelectedRowIds(useConversationShareSelectionStore.getState(), sessionId),
  );
  const store = useConversationShareSelectionStore.getState();
  return (
    <>
      <ConversationShareMenu taskId={sessionId} />
      <button onClick={() => store.showSelectionPanel(sessionId)}>Show selection panel</button>
      <button onClick={() => store.showTimeline(sessionId)}>Show timeline</button>
      <button onClick={() => store.goToConfiguration(sessionId)}>Configure selection</button>
      <button onClick={() => store.goToSelection(sessionId)}>Back to selection</button>
      <button onClick={() => store.setAllRowsSelected(sessionId, true)}>Select all</button>
      <button onClick={() => store.setAllRowsSelected(sessionId, false)}>Deselect all</button>
      <button
        onClick={() => {
          setRows((current) => [...current.slice(0, 3), ...turn(2, true, "stream updated")]);
          setRevision((value) => value + 1);
        }}
      >
        Stream update
      </button>
      <button
        onClick={() => {
          setRows((current) => [...current.slice(0, 3), ...turn(2)]);
          setRevision((value) => value + 1);
        }}
      >
        Complete turn
      </button>
      <button
        onClick={() => {
          rowReads = 0;
          textReads = 0;
          setRevision((value) => value + 1);
        }}
      >
        Reset work counters
      </button>
      <output aria-label="Share status">
        {JSON.stringify({
          active,
          view: draft?.view ?? "none",
          stage: draft?.stage ?? "none",
          selected: [...selected],
          items: result.shareItems.length,
          products: result.eligibleShareProductTurnIds,
          rowReads,
          textReads,
          revision,
        })}
      </output>
      <div style={{ position: "relative", height: 550 }}>
        <ConversationShareSelectionPanel
          visible={active && draft.stage === "selection" && draft.view === "selection"}
          items={result.shareItems}
          selectedRowIds={selected}
          onToggle={(id) => store.toggleRow(sessionId, id)}
          onInspect={() => store.showTimeline(sessionId)}
        />
      </div>
    </>
  );
}
// 真实 Root 提供共享 Tooltip 上下文；独立夹具也需同一根，否则分享入口在首次渲染时抛错。
createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale="en-US">
    <TooltipProvider>
      <Fixture />
    </TooltipProvider>
  </ZCodeIntlProvider>,
);
