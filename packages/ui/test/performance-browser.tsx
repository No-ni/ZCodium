// 浏览器交互夹具：真实 hooks / navigator / lazy 入口，Host 返回值由测试控制。
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor } from "@zcode/services";
import type { WorkspaceFileEntry } from "@zcode/shared";
import { ServiceProvider } from "@/hooks/useServices.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { useCommandCenterFileSearch } from "@/hooks/useCommandCenterFileSearch.js";
import { useConversationWorkDuration } from "@/hooks/useConversationWorkDuration.js";
import { ConversationTurnNavigator } from "@/v4/ConversationTurnNavigator.js";
import { SettingsPage } from "@/root/LazySettingsPage.js";
import { TerminalSession } from "@/terminal/LazyTerminalSession.js";

const pending = new Map<string, (files: WorkspaceFileEntry[]) => void>();
Object.assign(window, {
  performanceFixture: {
    complete(query: string, entries?: WorkspaceFileEntry[], workspaceIdentity = "") {
      pending.get(`${workspaceIdentity}:${query}`)?.(
        entries ?? [
          { name: query, path: `C:/synthetic/${query}`, relativePath: query, type: "file" },
        ],
      );
    },
    lazyEntries: [SettingsPage, TerminalSession],
  },
});
const services = {
  fileService: {
    searchWorkspaceFiles: ({
      query,
      workspaceIdentity = "",
    }: {
      query: string;
      workspaceIdentity?: string;
    }) =>
      new Promise<WorkspaceFileEntry[]>((resolve) =>
        pending.set(`${workspaceIdentity}:${query}`, resolve),
      ),
  },
} as unknown as IServiceAccessor;
const directory = Array.from({ length: 1000 }, (_, i) => ({
  rowId: i + 1,
  turnId: `t${i}`,
  userPreview: `question ${i}`,
  assistantPreview: "answer",
  assistantPreviewKind: "text" as const,
  isRunning: false,
}));
const status = { state: "running" as const, liveStartedAt: Date.now() - 3000, durationMs: 3000 };
let outerRenders = 0;
function Clock() {
  const duration = useConversationWorkDuration(status);
  return <output id="duration">{duration}</output>;
}
function Fixture() {
  outerRenders++;
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(true);
  const [workspaceIdentity, setWorkspaceIdentity] = useState("");
  const [jump, setJump] = useState("");
  const result = useCommandCenterFileSearch({
    enabled: open,
    rootPath: "C:/synthetic",
    ignoreRulesRoot: "C:/synthetic",
    workspaceIdentity,
    query,
  });
  return (
    <>
      <style>{`nav { position: relative; width: 100px; height: 250px; } nav > div { position: relative; height: 250px; width: 100px; overflow-y: auto; } nav > div > div > div { position: absolute; top: 0; left: 0; height: 10px; } nav button { box-sizing: border-box; padding: 0; border: 0; line-height: 10px; width: 40px; height: 10px; }`}</style>
      <label>
        Search
        <input
          aria-label="Search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <button onClick={() => setOpen(!open)}>Toggle search</button>
      <button onClick={() => setWorkspaceIdentity("remote-b")}>Switch scope</button>
      <output id="files">{result.files.map((file) => file.name).join(",")}</output>
      <output id="loading">{String(result.loading)}</output>
      <output id="outer-renders">{outerRenders}</output>
      <Clock />
      <output id="jump">{jump}</output>
      <ConversationTurnNavigator
        renderUnits={[]}
        directory={directory}
        scrollOffsetPx={0}
        viewportHeightPx={250}
        virtualItems={[]}
        onJumpToQuery={(target) => setJump(`${target.rowId}:${target.unitIndex}`)}
      />
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale="en-US">
    <ServiceProvider services={services}>
      <Fixture />
    </ServiceProvider>
  </ZCodeIntlProvider>,
);
