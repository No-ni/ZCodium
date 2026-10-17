import { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AssistantCodeCommentFeatureProvider } from "@/AssistantCodeCommentFeatureProvider.js";
import { useConversationTimelineFind } from "@/v4/useConversationTimelineFind.js";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";
import type { ConversationFindMatchState } from "@/v4/legacyChatViewTypes.js";

const rowText = new WeakMap<object, string>();
let initialBodyReads = 0;
function unit(
  rowId: number,
  text: string,
  running = false,
  onRead?: () => void,
): ConversationTurnRenderUnit {
  const row = {
    kind: "assistantText" as const,
    rowId,
    turnId: `turn-${rowId}`,
    createdAt: 1,
    createdAtSeq: rowId,
    state: running ? ("streaming" as const) : ("complete" as const),
    get text() {
      onRead?.();
      return text;
    },
  };
  rowText.set(row, text);
  return {
    key: row.turnId,
    visibleUserInputs: [],
    assistantTextRows: [row],
    latestAssistantTextRow: row,
    isRunning: running,
  } as unknown as ConversationTurnRenderUnit;
}
const initialUnit = unit(10, "alpha", false, () => initialBodyReads++);
const olderUnit = unit(1, "alpha");
const commentUnit = unit(
  10,
  'alpha ::code-comment{title="hidden" body="secret" file="src/app.ts" start=1}',
);

function FindFixture() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("alpha");
  const [currentUnit, setCurrentUnit] = useState(initialUnit);
  const [prepend, setPrepend] = useState(false);
  const [state, setState] = useState<ConversationFindMatchState>({
    matchCount: 0,
    activeIndex: -1,
  });
  const [target, setTarget] = useState(-1);
  const renderUnits = useMemo(
    () => (prepend ? [olderUnit, currentUnit] : [currentUnit]),
    [prepend, currentUnit],
  );
  const rows = useMemo(
    () => renderUnits.flatMap((entry) => entry.assistantTextRows),
    [renderUnits],
  );
  useConversationTimelineFind({
    rootRef,
    renderUnits,
    rows,
    mountedRowsKey: "fixture",
    canLoadOlder: false,
    loadingOlder: false,
    conversationFindQuery: query,
    conversationFindActiveIndex: 0,
    conversationFindNavigationRequestId: 0,
    onConversationFindMatchStateChange: setState,
    scrollToUnit: setTarget,
  });
  return (
    <>
      <input aria-label="Find" value={query} onChange={(event) => setQuery(event.target.value)} />
      <button onClick={() => setCurrentUnit(unit(10, "beta beta"))}>Replace snapshot</button>
      <button
        onClick={() => {
          setCurrentUnit(initialUnit);
          setPrepend(false);
        }}
      >
        Reset
      </button>
      <button onClick={() => setPrepend(true)}>Prepend history</button>
      <button onClick={() => setCurrentUnit(unit(10, "alpha alpha", true))}>
        Streaming update
      </button>
      <button onClick={() => setCurrentUnit(commentUnit)}>Comment</button>
      <output id="matches">{state.matchCount}</output>
      <output id="active">{state.activeIndex}</output>
      <output id="target">{target}</output>
      <output id="initial-body-reads">{initialBodyReads}</output>
      <div ref={rootRef}>
        {rows.map((row) => (
          <p key={row.rowId} data-conversation-row-id={row.rowId}>
            {rowText.get(row)}
          </p>
        ))}
      </div>
    </>
  );
}

function Fixture() {
  const [enabled, setEnabled] = useState(false);
  return (
    <AssistantCodeCommentFeatureProvider enabled={enabled}>
      <button onClick={() => setEnabled((value) => !value)}>Toggle comments</button>
      <FindFixture />
    </AssistantCodeCommentFeatureProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
