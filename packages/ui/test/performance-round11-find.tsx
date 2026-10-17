import { useCallback, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useConversationTimelineFind } from "@/v4/useConversationTimelineFind.js";
import { buildConversationFindIndex } from "@/v4/conversationFindIndex.js";
import {
  applyConversationFindHighlights,
  clearConversationFindHighlights,
} from "@/v4/conversationFindHighlightDom.js";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";
import type { ChatSearchResultHighlightRequest } from "@/v4/legacyChatViewTypes.js";

const body = "needle ".repeat(1000) + "tail";
function unit(rowId: number, text: string): ConversationTurnRenderUnit {
  const row = { kind: "assistantText", rowId, turnId: `t-${rowId}`, text, state: "complete" };
  return {
    visibleUserInputs: [],
    assistantTextRows: [row],
    latestAssistantTextRow: row,
    isRunning: false,
  } as unknown as ConversationTurnRenderUnit;
}
const initial = unit(10, body);
const older = unit(1, "needle target section");

function SnippetFixture() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [request, setRequest] = useState<ChatSearchResultHighlightRequest | null>(null);
  const [history, setHistory] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [loads, setLoads] = useState(0);
  const [target, setTarget] = useState(-1);
  const [done, setDone] = useState(-1);
  const renderUnits = useMemo(() => (history ? [older, initial] : [initial]), [history]);
  const rows = useMemo(
    () => renderUnits.flatMap((entry) => entry.assistantTextRows),
    [renderUnits],
  );
  const onLoadOlder = useCallback(() => {
    setLoads((value) => value + 1);
    setLoading(true);
  }, []);
  useConversationTimelineFind({
    rootRef,
    renderUnits,
    rows,
    mountedRowsKey: history ? "history" : "initial",
    canLoadOlder: !exhausted,
    loadingOlder: loading,
    onLoadOlder,
    sessionPhase: running ? "running" : "completedSuccess",
    conversationFindQuery: "",
    conversationFindActiveIndex: 0,
    conversationFindNavigationRequestId: 0,
    searchResultHighlightRequest: request,
    scrollToUnit: setTarget,
    onSearchResultHighlightDone: setDone,
  });
  const search = (snippet: string, snippetIndex = 0) =>
    setRequest((value) => ({
      requestId: (value?.requestId ?? 0) + 1,
      taskId: "fixture",
      workspacePath: "fixture",
      query: "needle",
      snippet,
      snippetIndex,
    }));
  return (
    <>
      <button onClick={() => search("target section")}>Locate snippet</button>
      <button
        onClick={() => {
          setHistory(true);
          setLoading(false);
          setExhausted(true);
        }}
      >
        Complete history
      </button>
      <button onClick={() => search("missing snippet", 500)}>Missing fallback</button>
      <button
        onClick={() => {
          setRunning(true);
          setTarget(-1);
        }}
      >
        Run
      </button>
      <button onClick={() => setRunning(false)}>Stop</button>
      <output id="loads">{loads}</output>
      <output id="target">{target}</output>
      <output id="done">{done}</output>
      <div ref={rootRef}>
        {rows.map((row) => (
          <p key={row.rowId} data-row-id={row.rowId}>
            {row.text}
          </p>
        ))}
      </div>
    </>
  );
}

// 只对同步 apply 调用计量；每次读取真实 DOM，测试结束清除注册表和节点。
function domBudget() {
  const root = document.createElement("div");
  const row = document.createElement("p");
  row.dataset.rowId = "1";
  row.textContent = "needle ".repeat(500);
  root.append(row);
  document.body.append(root);
  const index = buildConversationFindIndex([unit(1, row.textContent)], "needle");
  const original = document.createRange;
  let createdRanges = 0;
  document.createRange = function () {
    createdRanges++;
    return original.call(document);
  };
  try {
    const active = applyConversationFindHighlights({
      root,
      query: "needle",
      matches: index.matches,
      activeMatch: index.matches[123],
    });
    const registry = (
      CSS as unknown as { highlights: Map<string, Set<Range> & { priority: number }> }
    ).highlights;
    const budget = {
      createdRanges,
      highlights: registry.get("zcode-v4-conversation-find")?.size,
      activeText: active?.toString(),
      sharedActive: registry.get("zcode-v4-conversation-find")?.has(active!),
    };
    row.textContent = "changed needle";
    const changed = applyConversationFindHighlights({
      root,
      query: "needle",
      matches: [index.matches[0]!],
      activeMatch: null,
    });
    const changedRange = [...registry.get("zcode-v4-conversation-find")!][0];
    const changedCorrectly = changed === null && changedRange?.startOffset === 8;
    row.remove();
    applyConversationFindHighlights({
      root,
      query: "needle",
      matches: [index.matches[0]!],
      activeMatch: index.matches[0]!,
    });
    const missing = registry.get("zcode-v4-conversation-find")?.size;
    row.textContent = "needle";
    root.append(row);
    applyConversationFindHighlights({
      root,
      query: "needle",
      matches: [index.matches[0]!],
      activeMatch: null,
    });
    const remounted = registry.get("zcode-v4-conversation-find")?.size;
    const duplicateRow = Object.assign(document.createElement("p"), {
      textContent: "duplicate needle",
    });
    duplicateRow.dataset.rowId = "1";
    root.append(duplicateRow);
    const activeRow = Object.assign(document.createElement("p"), { textContent: "active needle" });
    activeRow.dataset.rowId = "2";
    root.append(activeRow);
    const activeOnlyMatch = buildConversationFindIndex([unit(2, activeRow.textContent)], "needle")
      .matches[0]!;
    const activeOnlyRange = applyConversationFindHighlights({
      root,
      query: "needle",
      matches: [index.matches[0]!],
      activeMatch: activeOnlyMatch,
    });
    const firstDomRow =
      [...registry.get("zcode-v4-conversation-find")!][0]?.startContainer.parentElement === row;
    const activeOutsideMatches = activeOnlyRange?.startContainer.parentElement === activeRow;
    const priorities = [
      registry.get("zcode-v4-conversation-find")?.priority,
      registry.get("zcode-v4-conversation-find-active")?.priority,
    ];
    duplicateRow.remove();
    activeRow.remove();
    const finalSpan = Object.assign(document.createElement("span"), { textContent: "needle" });
    row.replaceChildren(
      document.createTextNode("nee"),
      Object.assign(document.createElement("span"), { textContent: "dle" }),
      finalSpan,
    );
    applyConversationFindHighlights({
      root,
      query: "needle",
      matches: [index.matches[0]!],
      activeMatch: null,
    });
    const textNodeBoundaries =
      registry.get("zcode-v4-conversation-find")?.size === 1 &&
      [...registry.get("zcode-v4-conversation-find")!][0]?.startContainer.parentElement ===
        finalSpan;
    row.replaceChildren(
      Object.assign(document.createElement("button"), { textContent: "needle" }),
      document.createTextNode("visible needle"),
    );
    applyConversationFindHighlights({
      root,
      query: "needle",
      matches: [index.matches[0]!],
      activeMatch: index.matches[0]!,
    });
    const visibleRange = [...registry.get("zcode-v4-conversation-find")!][0];
    const ignoredControls = visibleRange?.startContainer.parentElement === row;
    applyConversationFindHighlights({
      root,
      query: "  ",
      matches: index.matches,
      activeMatch: index.matches[0]!,
    });
    return {
      ...budget,
      changed: changedCorrectly,
      missing,
      remounted,
      firstDomRow,
      activeOutsideMatches,
      priorities,
      textNodeBoundaries,
      ignoredControls,
      empty: registry.get("zcode-v4-conversation-find")?.size,
    };
  } finally {
    document.createRange = original;
    clearConversationFindHighlights();
    root.remove();
  }
}

Object.assign(window, { round11Find: { domBudget } });
createRoot(document.getElementById("root")!).render(<SnippetFixture />);
