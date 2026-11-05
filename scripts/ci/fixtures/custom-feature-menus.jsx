import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PlatformProvider } from "../../../packages/ui/src/hooks/usePlatform.js";
import { ServiceProvider } from "../../../packages/ui/src/hooks/useServices.js";
import { TabStoreProvider } from "../../../packages/ui/src/store/TabStoreProvider.js";
import { useRemoteWorkspaceSessionStore } from "../../../packages/ui/src/store/remoteWorkspaceSessionStore.js";
import { ZCodeIntlProvider, useZCodeIntl } from "../../../packages/ui/src/i18n/IntlProvider.js";
import { useTaskListItemContextActions } from "../../../packages/ui/src/useTaskListItemContextActions.js";
import { TaskActionMenuContent } from "../../../packages/ui/src/TaskActionMenuContent.js";
import { GroupedTaskContextMenuContent } from "../../../packages/ui/src/project-sidebar/grouped/task-context-menu-content.js";
import { useProjectFileTree } from "../../../packages/ui/src/project-sidebar/useProjectFileTree.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../../../packages/ui/src/components/ui/dropdown-menu.js";
import {
  ContextMenu,
  ContextMenuTrigger,
} from "../../../packages/ui/src/components/ui/context-menu.js";

const params = new URLSearchParams(location.search);
const mode = params.get("mode") || "success";
const noop = () => {};
const state = (window.customFixture = {
  queries: [],
  opens: [],
  errors: [],
  configQueries: 0,
  configOpens: [],
});
const configPath = "/environment/runtime/provider/bundled/zcode-builtin.json";
let resolveConfig;
const configGate =
  mode === "loading"
    ? new Promise((resolve) => {
        resolveConfig = resolve;
      })
    : Promise.resolve();
let resolveTask;
function services(host) {
  return {
    zcodeSessionService: {
      listSessions: async (input) => {
        state.queries.push({ host, input, kind: "list" });
        if (input.sessionIds[0] === "slow")
          await new Promise((resolve) => {
            resolveTask = resolve;
          });
        if (input.sessionIds[0] === "fallback") return [];
        return [
          {
            sessionId: input.sessionIds[0],
            executionWorkspacePath: `/${host}/2026-11-05/${input.sessionIds[0]}`,
          },
        ];
      },
    },
    zcodeAgentService: {
      readSession: async (input) => {
        state.queries.push({ host, input, kind: "read" });
        return {
          session: { sessionId: input.sessionId, executionWorkspacePath: `/${host}/fallback` },
        };
      },
    },
  };
}
const base = services("local");
const remote = services("remote");
useRemoteWorkspaceSessionStore.setState({
  baseServices: base,
  sessionsById: {
    "remote-host": {
      sessionId: "remote-host",
      workspaceIdentity: "remote-fixture",
      services: remote,
    },
  },
  sessionIdByWorkspaceIdentity: { "remote-fixture": "remote-host" },
});
const platform =
  mode === "unsupported"
    ? {}
    : {
        getBuiltinProviderConfigFile: async () => {
          state.configQueries++;
          await configGate;
          if (mode === "query-error") throw new Error("fixture query rejected");
          return { path: configPath, exists: mode !== "missing" };
        },
        openExternalFile: async (path) => {
          state.configOpens.push(path);
          if (mode === "open-throw") throw new Error("fixture open rejected");
          return { success: mode !== "open-failure" };
        },
      };
const task = {
  taskId: "task-a",
  workspacePath: "/fixture",
  hostId: "fixture-host",
  title: "Fixture",
};
function FileActions() {
  const fileTree = useProjectFileTree(
    {
      workspacePath: "/fixture",
      onOpenFileManager: (target) => state.opens.push(target),
    },
    { hosts: [] },
  );
  const open = (id, identity) => {
    void fileTree
      .openTaskFiles({ ...task, taskId: id, ...(identity ? { workspaceIdentity: identity } : {}) })
      .catch((error) => state.errors.push(error.message));
  };
  return (
    <>
      <button data-testid="files-a" onClick={() => open("task-a")}>
        A files
      </button>
      <button data-testid="files-b" onClick={() => open("task-b")}>
        B files
      </button>
      <button data-testid="files-slow" onClick={() => open("slow")}>
        Slow files
      </button>
      <button data-testid="files-fallback" onClick={() => open("fallback")}>
        Fallback files
      </button>
      <button data-testid="files-remote" onClick={() => open("task-a", "remote-fixture")}>
        Remote files
      </button>
      <button data-testid="files-remote-slow" onClick={() => open("slow", "remote-fixture")}>
        Remote slow files
      </button>
      <button data-testid="files-offline" onClick={() => open("task-a", "offline-fixture")}>
        Offline files
      </button>
    </>
  );
}
function Fixture() {
  const { intl } = useZCodeIntl();
  const [enabled, setEnabled] = useState(false);
  const [filesMounted, setFilesMounted] = useState(true);
  const actions = useTaskListItemContextActions({
    workspacePath: "/fixture",
    taskId: "task-a",
    intl,
    loadTaskPaths: false,
    loadProviderConfig: enabled,
    ...(mode === "remote"
      ? { workspaceIdentity: "remote-fixture", remoteSessionId: "remote-host" }
      : {}),
  });
  const common = {
    intl,
    fileManagerLabel: "Open folder",
    taskSessionFile: actions.taskSessionFile,
    taskNativeSessionLogFile: actions.taskNativeSessionLogFile,
    providerConfigFile: actions.providerConfigFile,
    onOpenTaskPathInFileManager: noop,
    onCopyWorkspacePath: noop,
    onOpenProviderConfig: () => void actions.handleOpenProviderConfig(),
  };
  state.loading = actions.providerConfigFile.loading;
  state.enabled = enabled;
  return (
    <main>
      <DropdownMenu onOpenChange={setEnabled}>
        <DropdownMenuTrigger data-testid="open-menu">Task menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <TaskActionMenuContent
            {...common}
            activeSessionId="task-a"
            isPinned={false}
            Item={DropdownMenuItem}
            Separator={DropdownMenuSeparator}
            onTogglePinTask={noop}
            onStartRenameTask={noop}
            onArchiveTask={noop}
            onMarkTaskAsUnread={noop}
            onCopyTaskPath={noop}
            onCopyTaskLogPath={noop}
            onCopySessionId={noop}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <ContextMenu onOpenChange={setEnabled}>
        <ContextMenuTrigger data-testid="grouped-menu">Grouped task</ContextMenuTrigger>
        <GroupedTaskContextMenuContent
          {...common}
          task={task}
          groups={[]}
          onMoveTaskToGroup={noop}
          onMoveTaskToTop={noop}
          onStartRenameTask={noop}
          onArchiveTask={noop}
          onMarkTaskAsUnread={noop}
          onCopyText={noop}
          onOpenTaskFeedback={noop}
        />
      </ContextMenu>
      {filesMounted ? <FileActions /> : null}
      <button data-testid="release-task" onClick={() => resolveTask?.()}>
        Release task
      </button>
      <button data-testid="release-config" onClick={() => resolveConfig?.()}>
        Release config
      </button>
      <button data-testid="unmount-files" onClick={() => setFilesMounted(false)}>
        Unmount files
      </button>
      <button
        data-testid="disconnect"
        onClick={() => useRemoteWorkspaceSessionStore.setState({ sessionsById: {} })}
      >
        Disconnect
      </button>
    </main>
  );
}
createRoot(document.getElementById("root")).render(
  <PlatformProvider platform={platform}>
    <ServiceProvider services={remote}>
      <TabStoreProvider>
        <ZCodeIntlProvider initialLocale={params.get("locale") || "en-US"}>
          <Fixture />
        </ZCodeIntlProvider>
      </TabStoreProvider>
    </ServiceProvider>
  </PlatformProvider>,
);
