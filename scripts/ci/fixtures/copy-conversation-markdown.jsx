import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PlatformProvider } from "../../../packages/ui/src/hooks/usePlatform.js";
import { ZCodeIntlProvider, useZCodeIntl } from "../../../packages/ui/src/i18n/IntlProvider.js";
import { TaskActionMenuContent } from "../../../packages/ui/src/TaskActionMenuContent.js";
import { useCopyConversationMarkdown } from "../../../packages/ui/src/hooks/useCopyConversationMarkdown.js";
import {
  writeBrowserClipboardText,
  isBrowserClipboardAvailable,
} from "../../../packages/ui/src/lib/browserClipboard.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../../packages/ui/src/components/ui/dropdown-menu.js";

const params = new URLSearchParams(location.search);
const mode = params.get("mode") || "success";
window.copyFixture = {
  reads: [],
  writes: 0,
  submissions: 0,
  copied: "previous clipboard",
  pending: false,
};
let releaseRead;
const readGate =
  mode === "pending"
    ? new Promise((resolve) => {
        releaseRead = resolve;
      })
    : Promise.resolve();
const rows = Array.from({ length: 620 }, (_, index) => ({
  rowId: index + 1,
  turnId: `turn-${Math.floor(index / 2)}`,
  productTurnId: `product-${Math.floor(index / 2)}`,
  createdAt: 1,
  createdAtSeq: index + 1,
  ...(index % 2
    ? {
        kind: "assistantText",
        state: "complete",
        text: index === 619 ? "Latest answer" : `Answer ${index}`,
      }
    : {
        kind: "userInput",
        origin: "realUser",
        text: index === 0 ? "Earliest question" : `Question ${index}`,
      }),
}));
if (mode === "formatting") {
  rows[0].text = "Earliest question\n\n```js\nconst a = 1;";
  rows[0].attachments = [
    {
      ref: "C:\\Docs\\report#draft%.pdf",
      fileName: "Windows report",
      mime: "application/pdf",
      bytes: 1,
    },
  ];
}
const agent = {
  conversationRowsRangeV4: async (input) => {
    window.copyFixture.reads.push(input);
    await readGate;
    if (mode === "read-error" || mode === "both-fail") throw new Error("Fixture connection failed");
    const eligible =
      mode === "empty"
        ? []
        : mode === "projected-empty"
          ? [{ ...rows[1], text: ':zcode-file-citation{path=""}' }]
          : rows.filter((row) => input.beforeRowId === undefined || row.rowId < input.beforeRowId);
    const page = eligible.slice(-input.limit);
    return {
      rows: page,
      hasMore: eligible.length > page.length,
      atRevision: mode === "changed" && input.beforeRowId !== undefined ? 2 : 1,
      atLogEpoch: "fixture-epoch",
    };
  },
};
// 只替换系统剪贴板这个副作用，实际 ClipboardItem、平台封装、hook 和菜单照常运行。
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: {
    write: async ([item]) => {
      window.copyFixture.submissions++;
      if (mode === "clipboard-failure" || mode === "both-fail") throw new Error("Clipboard denied");
      const value = await (await item.getType("text/plain")).text();
      window.copyFixture.writes++;
      window.copyFixture.copied = value;
    },
    writeText: async (value) => {
      window.copyFixture.copied = value;
    },
  },
});
if (mode === "api-unavailable")
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
const platform = {
  ...(mode === "no-platform"
    ? {}
    : {
        writeClipboardText: isBrowserClipboardAvailable() ? writeBrowserClipboardText : undefined,
      }),
  getBuiltinProviderConfigFile: async () => ({ path: null, exists: false }),
};
const pathState = { loading: false, exists: false, path: null };
function Fixture() {
  const { intl } = useZCodeIntl();
  const [sessionId, setSessionId] = useState(mode === "no-session" ? null : "session-a");
  const action = useCopyConversationMarkdown(agent, {
    workspacePath: "/fixture",
    workspaceIdentity: params.get("remote") ? "remote-fixture" : undefined,
    remoteSessionId: params.get("remote") ? "remote-host" : undefined,
    sessionId,
    title: sessionId === "session-b" ? "Conversation B" : "Conversation A",
    showReasoning: true,
  });
  window.copyFixture.pending = action.pending;
  const noop = () => {};
  return (
    <main>
      <h1>{sessionId ?? "New conversation"}</h1>
      <DropdownMenu>
        <DropdownMenuTrigger data-testid="open-menu">More</DropdownMenuTrigger>
        <DropdownMenuContent>
          <TaskActionMenuContent
            intl={intl}
            isPinned={false}
            fileManagerLabel="Open folder"
            taskSessionFile={pathState}
            taskNativeSessionLogFile={pathState}
            activeSessionId={sessionId}
            Item={DropdownMenuItem}
            Separator={DropdownMenuSeparator}
            onTogglePinTask={noop}
            onStartRenameTask={noop}
            onArchiveTask={noop}
            onMarkTaskAsUnread={noop}
            onOpenTaskPathInFileManager={noop}
            onCopyWorkspacePath={noop}
            onCopyTaskPath={noop}
            onCopyTaskLogPath={noop}
            onCopySessionId={() => {
              void navigator.clipboard.writeText(sessionId);
            }}
            onCopyMarkdown={() => {
              void action.copy();
            }}
            copyMarkdownPending={action.pending}
            copyMarkdownDisabled={!action.available}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <button data-testid="switch-session" onClick={() => setSessionId("session-b")}>
        Switch session
      </button>
      <button data-testid="resolve-read" onClick={() => releaseRead?.()}>
        Resolve read
      </button>
      <button
        data-testid="copy-twice"
        onClick={() => {
          void action.copy();
          void action.copy();
        }}
      >
        Copy twice
      </button>
    </main>
  );
}
createRoot(document.getElementById("root")).render(
  <PlatformProvider platform={platform}>
    <ZCodeIntlProvider initialLocale={params.get("locale") || "en-US"}>
      <Fixture />
    </ZCodeIntlProvider>
  </PlatformProvider>,
);
