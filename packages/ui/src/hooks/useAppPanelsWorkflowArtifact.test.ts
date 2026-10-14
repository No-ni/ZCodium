import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  localArtifacts: vi.fn(),
  remoteArtifacts: vi.fn(),
  openBrowser: vi.fn(),
  openArtifact: vi.fn(),
}));
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({
    zcodeAgentService: { conversationWorkflowRunArtifactsV4: fixture.remoteArtifacts },
    zcodeSessionService: {},
  }),
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => ({
    zcodeAgentService: { conversationWorkflowRunArtifactsV4: fixture.localArtifacts },
  }),
}));
vi.mock("@/lib/workspaceSidePane.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspaceSidePane.js")>()),
  openOrActivateBrowserSidePaneByUrl: fixture.openBrowser,
  openWorkflowArtifactSidePane: fixture.openArtifact,
}));
vi.mock("@/terminal/sidePaneTerminalSessionRegistry.js", () => ({
  sidePaneTerminalSessionRegistry: {},
}));
vi.mock("@/plugin-ui/index.js", () => ({ openPluginUiSidePane: vi.fn() }));
vi.mock("@/hooks/useModelTrajectoryOpenBridge.js", () => ({
  useModelTrajectoryOpenBridge: vi.fn(),
}));
vi.mock("@/hooks/useInterfaceMode.js", () => ({ useIsOfficeMode: () => false }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: () => "" } }),
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));
vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
import { useAppPanels } from "./useAppPanels.js";

const root = "/Users/me/.zcodium/workspace/default";
const executionRoot = `${root}/2026-10-14/a1b2c3d4/nested`;
const request = {
  workspacePath: root,
  parentSessionId: "parent",
  runId: "run",
  artifactId: "page",
  contentType: "text/html",
  fileReferenceRootPath: `${root}/2026-10-14/a1b2c3d4`,
};

function renderPanels() {
  let panels: ReturnType<typeof useAppPanels> | undefined;
  function Harness() {
    // 导航刚发起的同步帧仍使用旧远程 services；目标产物的来源是请求中的本地 scope。
    panels = useAppPanels({
      workspaceAbsPath: "/remote/project",
      workspaceIdentity: "remote:/remote/project",
      workspaceRemoteSessionId: "remote",
      activeTaskId: "old-parent",
      sidePaneOwnerId: "old-parent",
      terminalExecutionSessionId: null,
      terminalExecutionWorkspacePath: null,
      terminalExecutionPathReady: false,
      supportsEmbeddedBrowser: true,
      defaultWhiteboardNamePrefix: "Board",
    });
    return null;
  }
  renderToString(createElement(Harness));
  return panels!;
}

beforeEach(() => {
  vi.resetAllMocks();
  fixture.openBrowser.mockReturnValue({ tabs: [], activeTabId: null });
  fixture.openArtifact.mockReturnValue({ tabs: [], activeTabId: null });
  fixture.localArtifacts.mockResolvedValue({
    artifacts: [{ id: "page", sourcePath: "report.html" }],
    executionWorkspacePath: executionRoot,
  });
  // 两端复用相同 ID 时，旧 Host 会给出另一个目录，不能把它拼成本机 file URL。
  fixture.remoteArtifacts.mockResolvedValue({
    artifacts: [{ id: "page", sourcePath: "wrong.html" }],
    executionWorkspacePath: "/remote/project",
  });
});

describe("local workflow HTML opening keeps the request's Host", () => {
  it("queries the local journal and uses its run cwd before navigation commits", async () => {
    renderPanels().handleOpenWorkflowArtifact(request);
    await Promise.resolve();
    expect(fixture.remoteArtifacts).not.toHaveBeenCalled();
    expect(fixture.localArtifacts).toHaveBeenCalledExactlyOnceWith({
      workspacePath: root,
      sessionId: "parent",
      runId: "run",
    });
    expect(fixture.openBrowser).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        initialUrl: `file://${executionRoot}/report.html`,
        workspaceKey: root,
        ownerTaskId: "parent",
      }),
    );
  });

  it("falls back to the scoped artifact tab when the local query fails", async () => {
    fixture.localArtifacts.mockRejectedValue(new Error("capabilityUnsupported"));
    renderPanels().handleOpenWorkflowArtifact(request);
    await Promise.resolve();
    expect(fixture.remoteArtifacts).not.toHaveBeenCalled();
    expect(fixture.openBrowser).not.toHaveBeenCalled();
    expect(fixture.openArtifact).toHaveBeenCalledWith(null, { ...request, workspaceKey: root });
  });

  it("opens explicit remote artifacts in their scoped tab without a local HTML query", () => {
    const remoteRequest = { ...request, workspaceIdentity: "remote:root", remoteSessionId: "R" };
    renderPanels().handleOpenWorkflowArtifact(remoteRequest);
    expect(fixture.localArtifacts).not.toHaveBeenCalled();
    expect(fixture.remoteArtifacts).not.toHaveBeenCalled();
    expect(fixture.openBrowser).not.toHaveBeenCalled();
    expect(fixture.openArtifact).toHaveBeenCalledWith(null, {
      ...remoteRequest,
      workspaceKey: "remote:root",
    });
  });
});
