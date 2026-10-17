import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Emitter } from "@zcode/rpc";
import type { IServiceAccessor, WindowHostControllerTaskListItem } from "@zcode/services";
import type { IPlatformService, WebRemoteControlStatusSnapshot } from "@zcode/shared";
import { CONTROLLER_TASKS_INDEX_TOPIC } from "@zcode/shared/zcode-protocol-v4";
import { PlatformProvider } from "../src/hooks/usePlatform.js";
import { ServiceProvider } from "../src/hooks/useServices.js";
import { useWebRemoteControlWindowSync } from "../src/hooks/useWebRemoteControlWindowSync.js";
import { TabStoreProvider } from "../src/store/TabStoreProvider.js";
import { useTabStore, useTabStoreApi } from "../src/store/TabStoreProvider.js";
import { isWorkspaceTab } from "../src/store/tabStore.js";

const statusEvents = new Emitter<WebRemoteControlStatusSnapshot>();
const controllerEvents = new Emitter();
const writes: { kind: string; payload: unknown }[] = [];
const subscriptions: string[] = [];
let status: WebRemoteControlStatusSnapshot = { status: "idle" };
let tasks = [
  {
    taskId: "pinned",
    title: "置顶运行任务",
    workspacePath: "/fixture-a",
    status: "completed",
    liveStatus: "running",
    createdAt: 1,
    updatedAt: 2,
  },
  {
    taskId: "other",
    title: "另一个项目任务",
    workspacePath: "/fixture-b",
    liveStatus: "running",
    createdAt: 1,
    updatedAt: 3,
  },
] as WindowHostControllerTaskListItem[];
let seq = 0;
const platform = {
  getWebRemoteControlStatus: async () => status,
  onWebRemoteControlStatusChanged: (listener: (value: WebRemoteControlStatusSnapshot) => void) => {
    const handle = statusEvents.event(listener);
    return () => handle.dispose();
  },
  syncWebRemoteControlWorkspaces: async (payload: unknown) => {
    writes.push({ kind: "workspaces", payload });
  },
  syncWebRemoteControlTasks: async (payload: unknown) => {
    writes.push({ kind: "tasks", payload });
  },
} as unknown as IPlatformService;
const services = {
  windowControllerService: {
    async listTaskList(query: { kind: string }) {
      if (query.kind !== "active")
        throw new Error("mobile requires active query including pinned tasks");
      return { items: tasks, total: tasks.length, hasMore: false };
    },
    onDynamicControllerFrame: () => controllerEvents.event,
    async subscribeControllerV4({ topic }: { topic: string }) {
      subscriptions.push(topic);
      return { ack: { subscriptionId: topic } };
    },
    async unsubscribeControllerV4() {},
  },
} as unknown as IServiceAccessor;

function Fixture() {
  const tabs = useTabStore((state) => state.tabs);
  const tabStore = useTabStoreApi();
  const [dialogOpen, setDialogOpen] = useState(false);
  useWebRemoteControlWindowSync({ enabled: true, workspaceTabs: tabs.filter(isWorkspaceTab) });
  useEffect(() => {
    tabStore.getState().addTab("/fixture-a");
    tabStore.getState().addTab("/fixture-b");
    Object.assign(window, {
      __windowSyncFixture: {
        writes,
        subscriptions,
        start() {
          status = {
            status: "active",
            sessionId: "fixture-pair",
            workspacePath: "/status-scope",
            workspaceIdentity: "status-identity",
          };
          statusEvents.fire(status);
        },
        stop() {
          status = { status: "idle" };
          statusEvents.fire(status);
        },
        update() {
          tasks = tasks.map((task) => ({
            ...task,
            title: `${task.title}已更新`,
            liveStatus: "completed",
          }));
          const nextSeq = ++seq;
          controllerEvents.fire({
            topic: CONTROLLER_TASKS_INDEX_TOPIC,
            subscriptionId: CONTROLLER_TASKS_INDEX_TOPIC,
            logEpoch: "fixture-epoch",
            fromSeq: nextSeq,
            toSeq: nextSeq,
            payload: { kind: "snapshot", snapshot: { tasks: [] } },
          });
        },
        closeWorkspace() {
          tabStore.getState().closeTab(tabStore.getState().tabs[0]!.id);
        },
      },
    });
  }, [tabStore]);
  return (
    <button onClick={() => setDialogOpen((open) => !open)}>
      {dialogOpen ? "关闭二维码弹窗" : "打开二维码弹窗"}
    </button>
  );
}

createRoot(document.getElementById("root")!).render(
  <ServiceProvider services={services}>
    <PlatformProvider platform={platform}>
      <TabStoreProvider>
        <Fixture />
      </TabStoreProvider>
    </PlatformProvider>
  </ServiceProvider>,
);
