import { Fragment, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { DesktopTopOverlay } from "../../../packages/ui/src/DesktopTopOverlay.js";
import { SettingsPage } from "../../../packages/ui/src/SettingsPage.js";
import { WorkspaceHelpMenuButton } from "../../../packages/ui/src/WorkspaceHelpMenuButton.js";
import { createHelpMenuFixture } from "./help-menu-probe.js";
import { PlatformProvider } from "../../../packages/ui/src/hooks/usePlatform.js";
import { TooltipProvider } from "../../../packages/ui/src/components/ui/tooltip.js";
import { ServiceProvider } from "../../../packages/ui/src/hooks/useServices.js";
import { ZCodeIntlProvider, useZCodeIntl } from "../../../packages/ui/src/i18n/IntlProvider.js";
import { StoreContext } from "../../../packages/ui/src/store/StoreProvider.js";
import { createZCodeStore } from "../../../packages/ui/src/store/index.js";
import { applyTheme } from "../../../packages/ui/src/useTheme.js";
import {
  TabStoreProvider,
  useTabStoreApi,
} from "../../../packages/ui/src/store/TabStoreProvider.js";
import { createHistoryNavigationProbe } from "./history-navigation-probe.js";
import { useRemoteWorkspaceSessionStore } from "../../../packages/ui/src/store/remoteWorkspaceSessionStore.js";
import {
  ProjectDirectoryProvider,
  useOptionalProjectDirectory,
} from "../../../packages/ui/src/project-sidebar/index.js";
import { useRootPlatformEffects } from "../../../packages/ui/src/root/useRootPlatformEffects.js";
import { useWorkspaceTaskNavigation } from "../../../packages/ui/src/app-shell/useWorkspaceTaskNavigation.js";
import { useAppKeyboard } from "../../../packages/ui/src/hooks/useAppKeyboard.js";
import { useShortcutCommandLabel } from "../../../packages/ui/src/shortcuts/useShortcutBindings.js";
import { useSettings } from "../../../packages/ui/src/hooks/useSettingService.js";
import { useBaseWorkspaceServices } from "../../../packages/ui/src/hooks/useWorkspaceServices.js";
import { useZCodeSessionStore } from "../../../packages/ui/src/store/zcodeSessionStore.js";
import { setPendingSettingsSectionIntent } from "../../../packages/ui/src/lib/settingsNavigation.js";
import {
  RootEventsProbe,
  rootEventsFixture,
  rootPlatformEventAdapters,
} from "./root-platform-events-probe.js";
import "../../../packages/ui/src/styles.css";

const noop = () => {};
const disposable = () => ({ dispose: noop });
const broadcasts = new Set<(event: { channel: string }) => void>();
const changes = new Set<() => void>();
const params = new URLSearchParams(location.search);
let tree = { projects: [], tasks: [] };
let instructions = "E2E_LOCAL_INSTRUCTIONS";
let localSettings: {
  httpProxy: string;
  terminalFontFamily: string;
  shortcutBindings?: Record<string, string[]>;
  keepAwakeWhileRunning?: boolean;
} = {
  httpProxy: "http://127.0.0.1:18080",
  terminalFontFamily: "E2E_LOCAL_FONT",
  ...(params.get("view") === "shortcut-probe"
    ? { shortcutBindings: { toggleSidebar: ["Ctrl+Shift+y"] } }
    : {}),
};
const calls = {
  back: 0,
  forward: 0,
  toggle: 0,
  create: 0,
  keyboard: 0,
  localWrites: [] as string[],
  foreignWrites: 0,
  localSettingsWrites: [] as object[],
  localSettingsReads: 0,
  foreignSettingsWrites: [] as object[],
  foreignSettingsReads: 0,
  badges: [] as unknown[],
  helpActions: [] as string[],
};
const helpMenuFixture = createHelpMenuFixture(params, calls);
const broadcastService = {
  send: async () => {},
  onMessage: (listener: (event: { channel: string }) => void) => {
    broadcasts.add(listener);
    return { dispose: () => broadcasts.delete(listener) };
  },
};
let heldSettingsReadStarted = false;
let shadowReadArmed = params.get("race") === "shadow";
let releaseHeldSettingsRead: (() => void) | undefined;
const settingService = {
  get: async () => {
    calls.localSettingsReads++;
    const captured = structuredClone(localSettings);
    if (
      (params.get("view") === "settings-race" && !heldSettingsReadStarted) ||
      (shadowReadArmed && calls.localSettingsReads === 2)
    ) {
      heldSettingsReadStarted = true;
      return new Promise<typeof localSettings>((resolve) => {
        releaseHeldSettingsRead = () => resolve(captured);
      });
    }
    return captured;
  },
  getDataBaseDir: async () => "fixture-data",
  update: async (patch: object) => {
    calls.localSettingsWrites.push(patch);
    localSettings = { ...localSettings, ...patch };
  },
  getUserInstructions: async () => ({ content: instructions, filePath: "fixture/AGENTS.md" }),
  saveUserInstructions: async (value: string) => {
    calls.localWrites.push(value);
    instructions = value;
  },
};
const services = {
  settingService,
  broadcastService,
  systemService: {
    info: async () => ({ platform: "win32", homedir: "fixture-home" }),
    listIntegratedTerminalShells: async () => [],
  },
  zcodeAgentService: {
    syncAppRuntimePreferences: async () => {},
    onDynamicSessionsIndexFrame: () => disposable,
    onAgentRuntimeRestarted: disposable,
    ensureHandshake: async () => {},
    subscribeSessionsIndexV4: async () => ({
      subscriptionId: "fixture-subscription",
      epoch: "fixture",
      sequence: 0,
      items: [],
    }),
    unsubscribeSessionsIndexV4: async () => {},
  },
  botsService: { syncAppRuntimePreferences: async () => {} },
  zcodeTaskService: { onDynamicWorkspaceEvent: () => disposable },
  windowProjectDirectory: {
    projectService: { readTree: async () => structuredClone(tree) },
    changesService: {
      onDidChange: (listener: () => void) => {
        changes.add(listener);
        return { dispose: () => changes.delete(listener) };
      },
    },
  },
} as never;
const foreignServices = {
  ...(services as object),
  settingService: {
    ...settingService,
    get: async () => {
      calls.foreignSettingsReads++;
      return {
        httpProxy: "http://127.0.0.1:28080",
        terminalFontFamily: "E2E_FOREIGN_FONT",
        shortcutBindings: { toggleSidebar: ["Ctrl+Shift+u"] },
      };
    },
    update: async (patch: object) => {
      calls.foreignSettingsWrites.push(patch);
    },
    saveUserInstructions: async () => {
      calls.foreignWrites++;
    },
  },
} as never;
const settingsChanged = new Set<() => void>();
const platform = {
  onFocusTab: () => noop,
  onNewTab: () => noop,
  onNewTask: () => noop,
  onOpenWorkspace: () => noop,
  onSettingsChanged: (callback: () => void) => {
    settingsChanged.add(callback);
    return () => {
      settingsChanged.delete(callback);
    };
  },
  ...rootPlatformEventAdapters,
  syncWindowTabs: noop,
  syncActiveTaskSession: noop,
  setApplicationLocale: async () => {},
  syncWindowUnreadCount: (snapshot: unknown) => calls.badges.push(snapshot),
  ...helpMenuFixture.platform,
  getDesktopWindowChromeState: async () => ({ isMaximized: false }),
  getWebRemoteControlStatus: async () => ({ enabled: false, clients: [] }),
} as never;
const store = createZCodeStore(broadcastService as never);
useRemoteWorkspaceSessionStore.setState({ baseServices: services });

function RootEffects() {
  const { intl } = useZCodeIntl();
  // 同时挂载真实 Root effects，旧缓存投影故意不为零，以检出第二个角标写者。
  useRootPlatformEffects({
    canBootstrapInitialWorkspace: false,
    platform,
    isDesktop: true,
    locale: "en-US",
    intl,
    tabs: [],
    addTab: noop,
    setIsBootstrappingInitialWorkspace: noop,
    activateTabByPath: () => false,
    startDraftInWorkspace: noop,
    startNewTaskFromActiveWorkspace: noop,
    openWorkspace: noop,
    openWorkspacePath: noop,
    setWorkspaceActionError: noop,
    totalUnreadTaskCount: 7,
    unreadSnapshot: { schemaVersion: 1, count: 1, taskKeys: ["stale-cache"] },
  } as never);
  return null;
}

function ShortcutProbe() {
  const label = useShortcutCommandLabel("toggleSidebar");
  useAppKeyboard({
    toggleSidebar: () => {
      calls.keyboard++;
    },
  });
  return <output data-testid="shortcut-probe-label">{label}</output>;
}

function SettingsSnapshotProbe() {
  const base = useBaseWorkspaceServices();
  const { settings, update } = useSettings({ services: base });
  const [saved, setSaved] = useState(false);
  return (
    <div>
      <button
        data-testid="settings-race-save"
        onClick={async () => {
          await update({ keepAwakeWhileRunning: true });
          setSaved(true);
        }}
      >
        Save
      </button>
      <output data-testid="settings-race-saved">{String(saved)}</output>
      <output data-testid="settings-race-value">
        {String(settings?.keepAwakeWhileRunning === true)}
      </output>
    </div>
  );
}

function App() {
  const tabStore = useTabStoreApi();
  const params = new URLSearchParams(location.search);
  const desktop = params.get("platform") !== "web";
  const mac = params.get("platform") === "mac";
  const [view, setView] = useState(params.get("view") ?? "overlay");
  const [sidebar, setSidebar] = useState(true);
  const [remoteProbe, setRemoteProbe] = useState(true);
  const { intl } = useZCodeIntl();
  const navigation = useWorkspaceTaskNavigation({
    intl,
    workspaceAbsPath: "fixture-workspace",
    workspaceIdentity: "fixture-remote",
    activateTabByPath: () => false,
  });
  const directory = useOptionalProjectDirectory();
  Object.assign(window, {
    fixtureCalls: calls,
    fixtureRoot: rootEventsFixture,
    fixtureHistory: createHistoryNavigationProbe(tabStore),
    fixture: {
      setView,
      ...helpMenuFixture.actions,
      setProbeRemote: setRemoteProbe,
      releaseSettingsRead: () => releaseHeldSettingsRead?.(),
      beginSettingsInteraction: () => {
        shadowReadArmed = false;
      },
      patchLocalSettings: (patch: object) => {
        localSettings = { ...localSettings, ...patch };
        for (const callback of settingsChanged) callback();
      },
      setNotification: (enabled: boolean) => store.setState({ notificationEnabled: enabled }),
      setTree: async (next: typeof tree) => {
        tree = next;
        await directory?.refresh();
      },
      intent: setPendingSettingsSectionIntent,
      setRestart: (enabled: boolean, identity = "fixture-remote") => {
        const state = useZCodeSessionStore.getState();
        const current = state.getWorkspaceState("fixture-workspace", identity || undefined);
        useZCodeSessionStore.setState({
          workspaces: {
            ...state.workspaces,
            [identity || "fixture-workspace"]: {
              ...current,
              modelSwitchPending: enabled,
              modelSwitchStage: enabled ? "restartingRuntime" : "idle",
            },
          },
        });
      },
    },
  });
  return (
    <>
      {view === "root-events" ? <RootEventsProbe platform={platform} /> : <RootEffects />}
      {view === "help-menu" ? (
        <WorkspaceHelpMenuButton isDesktop={desktop} />
      ) : view === "settings-race" ? (
        <ServiceProvider services={foreignServices}>
          <SettingsSnapshotProbe />
        </ServiceProvider>
      ) : view === "shortcut-probe" ? (
        <ServiceProvider services={remoteProbe ? foreignServices : services}>
          <ShortcutProbe />
        </ServiceProvider>
      ) : view === "settings" ? (
        <ServiceProvider services={foreignServices}>
          <SettingsPage
            isDesktop={desktop}
            isWindowsDesktop={desktop && !mac}
            isMacDesktop={mac}
            onBack={() => setView("overlay")}
          />
        </ServiceProvider>
      ) : (
        <div
          style={
            {
              height: "100vh",
              position: "relative",
              "--workspace-sidebar-panel-width": "268px",
            } as never
          }
        >
          <DesktopTopOverlay
            workspaceAbsPath="fixture-workspace"
            isDesktop={desktop}
            isWindowsDesktop={desktop && !mac}
            isMacDesktop={mac}
            isSidebarVisible={sidebar}
            updateReadyVersion={null}
            updateState={null}
            toggleSidebarShortcutLabel="Ctrl+B"
            newTaskShortcutLabel="Ctrl+N"
            goBackShortcutLabel="Alt+Left"
            goForwardShortcutLabel="Alt+Right"
            canTaskNavBack={view === "history" ? navigation.canTaskNavBack : true}
            canTaskNavForward={view === "history" ? navigation.canTaskNavForward : true}
            canGoBack
            canGoForward
            appLogoUrl="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"
            platform={platform}
            onToggleSidebar={() => {
              calls.toggle++;
              setSidebar(!sidebar);
            }}
            onCreateTask={() => {
              calls.create++;
            }}
            onGoBack={() => {
              if (view === "history") return navigation.handleTaskNavBack();
              calls.back++;
            }}
            onGoForward={() => {
              if (view === "history") return navigation.handleTaskNavForward();
              calls.forward++;
            }}
          />
        </div>
      )}
    </>
  );
}

if (params.get("view") === "history")
  useZCodeSessionStore.setState({
    taskNavHistory: {
      entries: ["before", "current", "after"].map((taskId) => ({
        kind: "task",
        workspacePath: "fixture-workspace",
        workspaceIdentity: "fixture-remote",
        taskId,
      })),
      cursor: 1,
    },
  });
applyTheme((params.get("theme") ?? "zai-light") as never);
const ValidationMode = params.has("strict") ? StrictMode : Fragment;
createRoot(document.getElementById("root")!).render(
  <ValidationMode>
    <ServiceProvider services={services}>
      <PlatformProvider platform={platform}>
        <StoreContext.Provider value={store}>
          <TabStoreProvider>
            <ZCodeIntlProvider initialLocale={(params.get("locale") ?? "en-US") as never}>
              <TooltipProvider>
                <ProjectDirectoryProvider isDesktop={params.get("platform") !== "web"}>
                  <App />
                </ProjectDirectoryProvider>
              </TooltipProvider>
            </ZCodeIntlProvider>
          </TabStoreProvider>
        </StoreContext.Provider>
      </PlatformProvider>
    </ServiceProvider>
  </ValidationMode>,
);
