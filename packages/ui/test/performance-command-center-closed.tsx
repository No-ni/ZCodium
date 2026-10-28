import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  IServiceAccessor,
  IWindowControllerService,
  WindowHostControllerFrame,
} from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { CONTROLLER_TASKS_INDEX_TOPIC } from "@zcode/shared/zcode-protocol-v4";
import { CommandCenterDialog } from "@/command-center/CommandCenterDialog.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { getWindowControllerTaskListRegistry } from "@/v4/windowControllerTaskListRegistry.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import "@/styles.css";

const tabs: WorkspaceTabState[] = [
  {
    id: "synthetic-tab",
    kind: "workspace",
    label: "Synthetic workspace",
    workspacePath: "C:/synthetic",
    workspaceIdentity: "synthetic-identity",
  },
];
const listeners = new Set<(frame: WindowHostControllerFrame) => void>();
let queries = 0;
let listenerCalls = 0;
let revision = 0;
let titleVersion = 1;
let selected = "";
const tasks = (): ZCodeTaskMeta[] => [
  {
    taskId: "task-synthetic",
    workspacePath: "C:/synthetic",
    workspaceIdentity: "synthetic-identity",
    title: `Synthetic task ${titleVersion}`,
    traceId: "synthetic-trace",
    mode: "build",
    createdAt: Date.UTC(2026, 9, 1),
    updatedAt: Date.UTC(2026, 9, 1),
  },
];
const controller = {
  onDynamicControllerFrame: () => (listener: (frame: WindowHostControllerFrame) => void) => {
    listeners.add(listener);
    return {
      dispose: () => {
        listeners.delete(listener);
      },
    };
  },
  subscribeControllerV4: async ({ topic }: { topic: string }) => ({
    ack: { subscriptionId: `synthetic-${topic}` },
  }),
  unsubscribeControllerV4: async () => undefined,
  resyncControllerV4: async () => undefined,
  listTaskList: async (query: { search?: string }) => {
    queries++;
    const items = tasks().filter(
      (task) => !query.search || task.title.toLowerCase().includes(query.search.toLowerCase()),
    );
    return { items, total: items.length, hasMore: false };
  },
} as unknown as IWindowControllerService;
const registry = getWindowControllerTaskListRegistry(controller);
const originalSubscribe = registry.subscribe;
const consumerListeners = new Set<() => void>();
registry.subscribe = (listener) => {
  const tracked = () => {
    listenerCalls++;
    listener();
  };
  consumerListeners.add(tracked);
  const dispose = originalSubscribe(tracked);
  return () => {
    consumerListeners.delete(tracked);
    dispose();
  };
};
const backgroundDispose = registry.subscribe(() => {
  renderStatus();
});
const services = {
  windowControllerService: controller,
  fileService: { searchWorkspaceFiles: async () => [] },
} as unknown as IServiceAccessor;

function renderStatus() {
  queueMicrotask(() => {
    const status = document.querySelector("#status");
    if (status)
      status.textContent = JSON.stringify({
        subscriptions: consumerListeners.size,
        controllerObservers: listeners.size,
        queries,
        listenerCalls,
        selected,
        titleVersion,
      });
  });
}
function publish() {
  titleVersion++;
  revision++;
  const frame = {
    subscriptionId: `synthetic-${CONTROLLER_TASKS_INDEX_TOPIC}`,
    topic: CONTROLLER_TASKS_INDEX_TOPIC,
    logEpoch: "synthetic-epoch",
    fromSeq: revision,
    toSeq: revision,
    payload: { kind: "snapshot", snapshot: { tasks: [] } },
  } as unknown as WindowHostControllerFrame;
  for (const listener of listeners) listener(frame);
  renderStatus();
}

function Fixture() {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(true);
  const [selection, setSelection] = useState("");
  renderStatus();
  return (
    <ServiceProvider services={services}>
      <ZCodeIntlProvider initialLocale="en-US">
        <main className="p-4 text-ui-base">
          <h1 className="text-ui-lg">Command Center closed subscriptions</h1>
          <button
            type="button"
            onClick={() => {
              setOpen(true);
              renderStatus();
            }}
          >
            Open Command Center
          </button>
          <button type="button" onClick={publish}>
            Publish task update
          </button>
          <button
            type="button"
            onClick={() => {
              setMounted(false);
              backgroundDispose();
              renderStatus();
            }}
          >
            Unmount consumers
          </button>
          <pre id="status" className="font-mono" aria-label="Subscription status" />
          <output aria-label="Selected task">{selection}</output>
          {mounted ? (
            <CommandCenterDialog
              open={open}
              commands={[]}
              workspaceAbsPath="C:/synthetic"
              workspaceIdentity="synthetic-identity"
              workspaceTabs={tabs}
              onOpenChange={(next) => {
                setOpen(next);
                renderStatus();
              }}
              onOpenCodeViewer={() => {
                throw new Error("Not used in this fixture");
              }}
              onSelectTask={(path, taskId, identity) => {
                selected = JSON.stringify({ path, taskId, identity });
                setSelection(selected);
                renderStatus();
              }}
            />
          ) : null}
        </main>
      </ZCodeIntlProvider>
    </ServiceProvider>
  );
}

window.addEventListener("error", (event) => {
  document.body.dataset.fixtureError = String(event.error ?? event.message);
});
createRoot(document.querySelector("#root")!).render(createElement(Fixture));
