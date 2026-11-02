import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ConversationShareMenu } from "@/ConversationShareMenu.js";
import { ConversationSharePopover } from "@/conversation-share-interaction/ConversationSharePopover.js";
import { ConversationShareSelectionPanel } from "@/v4/ConversationShareSelectionPanel.js";
import { ConversationShareConfirmationDock } from "@/v4/ConversationShareConfirmationDock.js";
import { ConversationShareSuccessDock } from "@/v4/ConversationShareSuccessDock.js";
import {
  getConversationShareSelectedProductTurnIds,
  useConversationShareSelectionStore,
  DEFAULT_CONVERSATION_SHARE_DOCK_STATE,
} from "@/store/conversationShareSelectionStore.js";
import "@/styles.css";

document.documentElement.className = "light theme-zai-light";
const items = [1, 2, 3].map((rowId) => ({
  key: String(rowId),
  rowId,
  unitIndex: rowId - 1,
  userPreview: `Fixture turn ${rowId}`,
  assistantPreview: "Completed synthetic reply",
  isRunning: false,
}));
function Fixture() {
  const state = useConversationShareSelectionStore();
  const draft = state.drafts.fixture;
  const dock = state.dockStates.fixture ?? DEFAULT_CONVERSATION_SHARE_DOCK_STATE;
  const editing = draft?.pendingExcludedRowIds != null;
  const [calls, setCalls] = useState(0);
  useEffect(() => {
    if (draft?.open)
      state.syncAvailableTurns(
        "fixture",
        items.map((item) => ({ rowId: item.rowId, productTurnId: String(item.rowId) })),
      );
  }, [draft?.open]);
  const confirmed = getConversationShareSelectedProductTurnIds(state, "fixture");
  const pending = getConversationShareSelectedProductTurnIds(state, "fixture", "pending");
  const selected = new Set(
    (draft?.availableRowIds ?? []).filter(
      (id) => !(draft?.pendingExcludedRowIds ?? draft?.excludedRowIds ?? []).includes(id),
    ),
  );
  const preflight = {
    status: "ready" as const,
    revision: 1,
    logEpoch: "fixture",
    capabilitiesFingerprint: "fixture",
    blockingIssues: [],
    skippableWarnings: [],
    deferredIssues: [],
    supportedArtifactTypes: [],
    turnResults: [],
  };
  const cancel = () => state.cancelSelectionEdit("fixture");
  return (
    <main className="relative flex h-screen flex-col bg-background text-foreground">
      <header className="flex h-12 shrink-0 items-center justify-end px-4">
        <ConversationShareMenu taskId="fixture" />
      </header>
      <div className="relative min-h-0 flex-1">
        <output data-testid="confirmed-count">{confirmed.length}</output>
        <output data-testid="publish-count">{calls}</output>
        <ConversationShareSelectionPanel
          visible={editing}
          items={items}
          selectedCount={pending.length}
          selectedRowIds={selected}
          preflight={preflight}
          onToggle={(id) => state.togglePendingRow("fixture", id)}
          onInspect={() => {}}
          onSelectAllChange={(value) => state.setAllPendingRowsSelected("fixture", value)}
          onConfirm={() => state.confirmSelectionEdit("fixture")}
          onCancel={cancel}
        />
      </div>
      <textarea
        aria-label="Composer"
        className="m-4 h-20 shrink-0 rounded-xl border border-border"
      />
      <ConversationSharePopover
        sessionId="fixture"
        open={draft?.open ?? false}
        publishing={dock.publishing}
        selecting={editing}
        onClose={() => state.closeShare("fixture")}
        onCancelSelection={cancel}
      >
        {dock.exportedFile ? (
          <ConversationShareSuccessDock
            title={dock.exportedFile.name}
            onDismiss={() => state.closeShare("fixture")}
          />
        ) : (
          <ConversationShareConfirmationDock
            key={JSON.stringify(confirmed)}
            selectedCount={confirmed.length}
            totalCount={items.length}
            title="Synthetic local archive"
            selectionEditing={editing}
            publishDisabled={editing}
            pending={dock.publishing}
            progressPhase={dock.progress}
            onCancel={() => state.closeShare("fixture")}
            onEditSelection={() => state.beginSelectionEdit("fixture")}
            onConfirm={() => {
              setCalls((value) => value + 1);
              state.updateDockState("fixture", { publishing: true });
            }}
          />
        )}
      </ConversationSharePopover>
      {dock.publishing ? (
        <button
          data-testid="complete-export"
          onClick={() =>
            state.updateDockState("fixture", {
              publishing: false,
              exportedFile: { name: "fixture.zcode", downloadStarted: false },
            })
          }
        >
          Complete synthetic export
        </button>
      ) : null}
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
