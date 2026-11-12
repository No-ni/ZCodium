/// <reference types="node" />
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BufferReader, BufferWriter, deserialize, serialize, VSBuffer } from "@zcode/rpc";
import {
  encodeWebRemoteControlRpcFrames,
  WebRemoteControlRpcAssembler,
  WebRemoteControlRpcReplayBuffer,
  WEB_REMOTE_CONTROL_RPC_LIMITS,
  type WebRemoteControlAppPayload,
  type WebRemoteControlBootstrapResult,
  type WebRemoteControlWorkspaceListResult,
  type WebRemoteControlTaskTarget,
  type IPlatformService,
  type ZCodeStreamEvent,
} from "@zcode/shared";
import { V4_WIRE_PROTOCOL_VERSION } from "@zcode/shared/zcode-protocol-v4";
import { SessionDataLayer } from "@zcode/ui/conversation-client";
import { MobileRemoteControlClient, readPairingParamsFromLocation } from "./protocol.js";
import { TaskConversationLifecycle } from "./taskConversationLifecycle.js";
import { conversationReducer, initialConversationState } from "./conversationReducer.js";
import { SharedMobileRootController } from "./shared-root/app/controller.js";
import { createMobileRootSlot } from "./shared-root/app/root-slot.js";
import { registerMobileRootWorkspace } from "./shared-root/adapters/workspace-registry.js";
import { getRegisteredBaseWorkspaceServices } from "@zcode/ui/remote-workspace-session-store";

// 与真实 Channel RPC 公共序列化格式一致；不 mock ChannelClient/RemoteServiceAccess。
const EVENT_LISTEN = 102;
const EVENT_DISPOSE = 103;
const INITIALIZE = 200;
const SUCCESS = 201;
const EVENT_FIRE = 204;

type BridgeOpen = Extract<WebRemoteControlAppPayload, { zcode_type: "workspace-bridge-open" }>;

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  sent: WebRemoteControlAppPayload[] = [];
  sentWire: Record<string, unknown>[] = [];
  private listeners = new Map<
    string,
    ((event: { data?: string; code?: number; reason?: string }) => void)[]
  >();
  constructor(_url: string) {
    FakeWebSocket.instances.push(this);
  }
  addEventListener(
    type: string,
    listener: (event: { data?: string; code?: number; reason?: string }) => void,
  ) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  fire(type: string, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.fire("open");
  }
  send(raw: string) {
    const frame = JSON.parse(raw);
    this.sentWire.push(frame);
    if (frame.type === "data") this.sent.push(frame.payload);
  }
  receive(payload: WebRemoteControlAppPayload) {
    this.wire({ type: "data", payload });
  }
  wire(frame: unknown) {
    this.fire("message", { data: JSON.stringify(frame) });
  }
  close() {
    this.readyState = 3;
    this.fire("close", { code: 1000, reason: "test" });
  }
  opens(): BridgeOpen[] {
    return this.sent.filter((p): p is BridgeOpen => p.zcode_type === "workspace-bridge-open");
  }
  ready(
    open: BridgeOpen,
    scope: { kind: "local" | "remote" | "conversation"; remoteSessionId?: string } = {
      kind: "local",
    },
  ) {
    this.receive({
      zcode_type: "workspace-bridge-ready",
      requestId: open.requestId,
      bridgeSessionId: open.bridgeSessionId,
      bridge: {
        bridgeSessionId: open.bridgeSessionId,
        workspaceKey: open.workspaceKey,
        workspacePath: "/workspace",
        ...scope,
        entryKind: "task",
      },
    });
  }
}

function rpcBytes(header: number[], body?: unknown) {
  const writer = new BufferWriter();
  serialize(writer, header);
  serialize(writer, body);
  return { __zcodeBytes: btoa(String.fromCharCode(...writer.buffer.buffer)) };
}

function host(socket: FakeWebSocket, streamId: string) {
  let seq = 0;
  return {
    send(header: number[], body?: unknown) {
      seq += 1;
      const frames = encodeWebRemoteControlRpcFrames(rpcBytes(header, body), { streamId, seq });
      for (const frame of frames) socket.receive({ zcode_type: "rpc-frame", frame });
      return frames;
    },
  };
}

function requests(socket: FakeWebSocket, streamId: string) {
  const assembler = new WebRemoteControlRpcAssembler({ streamId });
  const output: { seq: number; header: (number | string)[]; body: unknown }[] = [];
  for (const payload of socket.sent) {
    if (payload.zcode_type !== "rpc-frame" || payload.frame.streamId !== streamId) continue;
    if (payload.frame.kind === "ack") continue;
    for (const event of assembler.push(payload.frame)) {
      if (event.kind !== "message") continue;
      const value = event.message as { __zcodeBytes: string };
      const reader = new BufferReader(
        VSBuffer.wrap(Uint8Array.from(atob(value.__zcodeBytes), (char) => char.charCodeAt(0))),
      );
      output.push({ seq: event.seq, header: deserialize(reader), body: deserialize(reader) });
    }
  }
  return output;
}

async function flush() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}
const clients: MobileRemoteControlClient[] = [];
function client(onPayload = vi.fn<(payload: WebRemoteControlAppPayload) => void>()) {
  const onStateChange = vi.fn();
  const c = new MobileRemoteControlClient(
    { deviceSid: "test-device", passHash: "test-hash", wsUrl: "ws://localhost/ws" },
    {
      onPayload,
      onStateChange,
    },
  );
  clients.push(c);
  c.connect();
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open();
  socket.wire({ type: "auth_ack", pair_status: "matched" });
  return { c, socket, onPayload, onStateChange };
}
const access = { workspaceKey: "A", taskId: "task-a", workspacePath: "/workspace" };
const rootControllers: SharedMobileRootController[] = [];
// 此处不渲染 UI 或调用平台；真实 browser adapter 另有其 port 回归。
const unusedPlatform = {} as IPlatformService;
function rootBootstrap(
  windowId = "source-window-a",
  workspacePath = "/workspace",
): WebRemoteControlBootstrapResult {
  return {
    windowControlSessionId: windowId,
    desktopAppVersion: "3.17.1",
    workspaces: [{ workspaceKey: workspacePath, workspacePath, kind: "local" }],
    tasks: [{ workspaceKey: workspacePath, taskId: "source-task", title: "source fixture" }],
    mobileViewState: { activeWorkspaceKey: workspacePath, activeTaskId: "source-task" },
  };
}
function rootController(
  c: MobileRemoteControlClient,
  bootstrap = rootBootstrap(),
  onListUpdated: (result: WebRemoteControlWorkspaceListResult) => void = () => {},
) {
  const controller = new SharedMobileRootController(
    c,
    {
      registerWorkspace: registerMobileRootWorkspace,
      createPlatform: () => unusedPlatform,
    },
    onListUpdated,
  );
  rootControllers.push(controller);
  controller.start();
  controller.update("paired", bootstrap);
  return controller;
}
function rootReady(
  socket: FakeWebSocket,
  opened: BridgeOpen,
  workspacePath = opened.workspaceKey,
  scope: { kind: "local" | "remote"; workspaceIdentity?: string; remoteSessionId?: string } = {
    kind: "local",
  },
  withWindowDirectory = false,
) {
  socket.receive({
    zcode_type: "workspace-bridge-ready",
    requestId: opened.requestId,
    bridgeSessionId: opened.bridgeSessionId,
    bridge: {
      bridgeSessionId: opened.bridgeSessionId,
      bridgeGeneration: opened.bridgeGeneration,
      workspaceKey: opened.workspaceKey,
      workspacePath,
      ...scope,
      entryKind: "task",
      ...(withWindowDirectory ? { capabilities: { windowProjectDirectory: { version: 1 } } } : {}),
    },
  });
}
function rootTask(): WebRemoteControlTaskTarget {
  return {
    workspacePath: "/workspace",
    workspaceLabel: "source fixture",
    workspaceKind: "local",
    taskId: "source-task",
    title: "source fixture",
    unreadAt: 41,
    createdAt: 1,
    updatedAt: 2,
  };
}
function rootList(bootstrap = rootBootstrap()): WebRemoteControlWorkspaceListResult {
  return {
    workspaces: bootstrap.workspaces,
    tasks: bootstrap.tasks,
    activeWorkspaceKey: bootstrap.workspaces[0]!.workspaceKey,
  };
}
function rootRemoteBootstrap() {
  const bootstrap = rootBootstrap();
  bootstrap.workspaces.push({
    workspaceKey: "remote:source-b",
    workspaceIdentity: "remote:source-b",
    workspacePath: "/workspace-b",
    remoteSessionId: "source-remote-b",
    kind: "remote",
    connectionState: "connected",
  });
  bootstrap.tasks.push({
    workspaceKey: "remote:source-b",
    taskId: "source-task-b",
    title: "source fixture",
  });
  return bootstrap;
}

async function rootProjectOwner(
  c: MobileRemoteControlClient,
  socket: FakeWebSocket,
  bootstrap = rootBootstrap(),
) {
  const controller = rootController(c, bootstrap);
  await flush();
  const opened = socket.opens()[0]!;
  const source = host(socket, opened.bridgeSessionId);
  source.send([INITIALIZE]);
  rootReady(socket, opened, opened.workspaceKey, { kind: "local" }, true);
  await flush();
  const capability = requests(socket, opened.bridgeSessionId).find(
    (request) =>
      request.header[2] === "window-project-changes" && request.header[3] === "getCapabilities",
  );
  expect(capability).toBeDefined();
  source.send([SUCCESS, Number(capability!.header[1])], { version: 1 });
  await flush();
  return { controller, opened, source };
}

async function replyProjectDraftPreparation(
  socket: FakeWebSocket,
  opened: BridgeOpen,
  source: ReturnType<typeof host>,
  beforeListReply: () => void = () => {},
  workspacePath = "/workspace",
  bootstrap = rootBootstrap(),
) {
  await flush();
  const prepare = requests(socket, opened.bridgeSessionId).find(
    (request) => request.header[2] === "window-project" && request.header[3] === "prepareSession",
  );
  expect(prepare).toBeDefined();
  expect(prepare!.body).toEqual([{ projectId: "source-project" }]);
  source.send([SUCCESS, Number(prepare!.header[1])], {
    workspacePath,
    additionalDirectories: [],
    projectId: "source-project",
  });
  await flush();
  const list = socket.sent.findLast((payload) => payload.zcode_type === "workspace-list-request");
  expect(list?.zcode_type).toBe("workspace-list-request");
  if (list?.zcode_type !== "workspace-list-request") throw new Error("source-list-not-requested");
  beforeListReply();
  socket.receive({
    zcode_type: "workspace-list-response",
    requestId: list.requestId,
    success: true,
    result: rootList(bootstrap),
  });
  await flush();
}
const chunk: ZCodeStreamEvent = {
  type: "agent_message_chunk",
  taskId: access.taskId,
  traceId: "trace",
  messageId: "m",
  inputId: "input",
  content: "ha",
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("WebSocket", FakeWebSocket);
  FakeWebSocket.instances = [];
});
afterEach(() => {
  for (const controller of rootControllers.splice(0)) controller.dispose();
  for (const c of clients.splice(0)) c.dispose();
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("MobileRemoteControlClient fake WebSocket", () => {
  it.each([false, true])(
    "shared Root owner settles a current handoff failure once with sender unmounted=%s",
    async (unmounted) => {
      const { c, socket } = client();
      const bootstrap = rootBootstrap();
      bootstrap.workspaces.push({
        workspaceKey: "/workspace-b",
        workspacePath: "/workspace-b",
        kind: "local",
      });
      const { controller, opened, source } = await rootProjectOwner(c, socket, bootstrap);
      const origin = controller.getSnapshot().slot!;
      let callerCurrent = true;
      const unsubscribe = controller.subscribe(() => {
        if (unmounted && !controller.getSnapshot().slot) callerCurrent = false;
      });
      const error = vi.fn();
      const complete = vi.fn();
      const opening = origin.rootProps.webRemoteControlWorkspaceSwitcher!.openProjectDraft!({
        projectId: "source-project",
        isCurrent: () => callerCurrent,
        onError: error,
        onComplete: complete,
      }).then(
        () => "opened",
        (cause: Error) => cause.message,
      );
      await replyProjectDraftPreparation(
        socket,
        opened,
        source,
        () => {},
        "/workspace-b",
        bootstrap,
      );
      const target = socket.opens()[1]!;
      expect(target.workspaceKey).toBe("/workspace-b");
      rootReady(socket, target, "/unproved-target");
      expect(await opening).toBe("mobile-workspace-navigation-unavailable");
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0]![0]).toBeInstanceOf(Error);
      expect(complete).not.toHaveBeenCalled();
      expect(callerCurrent).toBe(!unmounted);
      expect(controller.getSnapshot()).toMatchObject({ slot: null, loading: false, error: true });
      unsubscribe();
    },
  );

  it.each(["window", "target"] as const)(
    "shared Root owner does not notify an old handoff failure after its %s is invalidated",
    async (change) => {
      const { c, socket } = client();
      const bootstrap = rootBootstrap();
      bootstrap.workspaces.push({
        workspaceKey: "/workspace-b",
        workspacePath: "/workspace-b",
        kind: "local",
      });
      const { controller, opened, source } = await rootProjectOwner(c, socket, bootstrap);
      const error = vi.fn();
      const complete = vi.fn();
      const opening = controller.getSnapshot().slot!.rootProps.webRemoteControlWorkspaceSwitcher!
        .openProjectDraft!({
        projectId: "source-project",
        isCurrent: () => true,
        onError: error,
        onComplete: complete,
      }).then(
        () => "opened",
        (cause: Error) => cause.message,
      );
      await replyProjectDraftPreparation(
        socket,
        opened,
        source,
        () => {},
        "/workspace-b",
        bootstrap,
      );
      const abandoned = socket.opens()[1]!;
      if (change === "window") controller.update("paired", rootBootstrap("source-window-new"));
      else controller.update("paired", rootBootstrap());
      await flush();
      rootReady(socket, abandoned, "/workspace-b");
      await flush();
      const replacement = socket
        .opens()
        .findLast((candidate) => candidate.workspaceKey === "/workspace");
      if (replacement && replacement !== opened) {
        rootReady(socket, replacement);
        await flush();
      }
      expect(await opening).not.toBe("opened");
      expect(error).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      expect(controller.getSnapshot().slot?.access.descriptor.workspaceKey).toBe("/workspace");
    },
  );

  it("shared Root owner reports an actual preparation error once while retaining the current task", async () => {
    const { c, socket } = client();
    const { controller, opened, source } = await rootProjectOwner(c, socket);
    const origin = controller.getSnapshot().slot!;
    const error = vi.fn();
    const complete = vi.fn();
    const opening = origin.rootProps.webRemoteControlWorkspaceSwitcher!.openProjectDraft!({
      projectId: "source-project",
      isCurrent: () => true,
      onError: error,
      onComplete: complete,
    }).then(
      () => "opened",
      (cause: Error) => cause.message,
    );
    await flush();
    const prepare = requests(socket, opened.bridgeSessionId).find(
      (request) => request.header[3] === "prepareSession",
    )!;
    source.send([202, Number(prepare.header[1])], {
      name: "Error",
      message: "project.primaryRootUnavailable",
    });
    expect(await opening).toBe("project.primaryRootUnavailable");
    expect(error).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ slot: origin, loading: false, error: true });
    expect(socket.opens()).toHaveLength(1);
    expect(socket.sent.some((payload) => payload.zcode_type === "workspace-list-request")).toBe(
      false,
    );
  });

  it("shared Root owner consumes the sender lease before a draft handoff unmounts the old Root", async () => {
    const { c, socket } = client();
    const { controller, opened, source } = await rootProjectOwner(c, socket);
    const origin = controller.getSnapshot().slot!;
    const complete = vi.fn();
    const error = vi.fn();
    let callerCurrent = true;
    const unsubscribe = controller.subscribe(() => {
      if (!controller.getSnapshot().slot) callerCurrent = false;
    });
    const opening = origin.rootProps.webRemoteControlWorkspaceSwitcher!.openProjectDraft!({
      projectId: "source-project",
      isCurrent: () => callerCurrent,
      onComplete: complete,
      onError: error,
    });
    await replyProjectDraftPreparation(socket, opened, source);
    await expect(opening).resolves.toBeUndefined();
    const target = controller.getSnapshot().slot!;
    expect(callerCurrent).toBe(false);
    expect(origin.rootProps.initialTaskDraft!.isCurrent!()).toBe(false);
    expect(target.access.services).toBe(origin.access.services);
    expect(socket.opens()).toHaveLength(1);
    expect(target.rootProps.initialTaskId).toBeUndefined();
    expect(target.rootProps.initialTaskDraft!.isCurrent!()).toBe(true);
    expect(complete).not.toHaveBeenCalled();
    target.rootProps.initialTaskDraft!.onComplete!();
    target.rootProps.initialTaskDraft!.onComplete!();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("shared Root owner rejects a cancelled sender before any project preparation", async () => {
    const { c, socket } = client();
    const { controller, opened } = await rootProjectOwner(c, socket);
    const origin = controller.getSnapshot().slot!;
    const complete = vi.fn();
    await expect(
      origin.rootProps.webRemoteControlWorkspaceSwitcher!.openProjectDraft!({
        projectId: "source-project",
        isCurrent: () => false,
        onComplete: complete,
      }),
    ).rejects.toThrow("project.navigation-cancelled");
    expect(controller.getSnapshot().slot).toBe(origin);
    expect(
      requests(socket, opened.bridgeSessionId).some(
        (request) => request.header[3] === "prepareSession",
      ),
    ).toBe(false);
    expect(socket.opens()).toHaveLength(1);
    expect(complete).not.toHaveBeenCalled();
  });

  it("shared Root owner rejects sender cancellation after the last preparation IO", async () => {
    const { c, socket } = client();
    const { controller, opened, source } = await rootProjectOwner(c, socket);
    const origin = controller.getSnapshot().slot!;
    const complete = vi.fn();
    let callerCurrent = true;
    const opening = origin.rootProps.webRemoteControlWorkspaceSwitcher!.openProjectDraft!({
      projectId: "source-project",
      isCurrent: () => callerCurrent,
      onComplete: complete,
    }).then(
      () => "opened",
      (error: Error) => error.message,
    );
    await replyProjectDraftPreparation(socket, opened, source, () => {
      callerCurrent = false;
    });
    expect(await opening).toBe("project.navigation-cancelled");
    expect(controller.getSnapshot().slot).toBe(origin);
    expect(socket.opens()).toHaveLength(1);
    expect(complete).not.toHaveBeenCalled();
  });

  it.each(["navigation", "target-invalidated"] as const)(
    "shared Root owner cancels a handed-off draft when %s replaces its target",
    async (change) => {
      const { c, socket } = client();
      const { controller, opened, source } = await rootProjectOwner(c, socket);
      const origin = controller.getSnapshot().slot!;
      const complete = vi.fn();
      const opening = origin.rootProps.webRemoteControlWorkspaceSwitcher!.openProjectDraft!({
        projectId: "source-project",
        isCurrent: () => true,
        onComplete: complete,
      });
      await replyProjectDraftPreparation(socket, opened, source);
      await opening;
      const target = controller.getSnapshot().slot!;
      expect(target.rootProps.initialTaskDraft!.isCurrent!()).toBe(true);
      if (change === "navigation") {
        await target.rootProps.webRemoteControlWorkspaceSwitcher!.startDraft!("/workspace");
        expect(controller.getSnapshot().slot).not.toBe(target);
      } else {
        controller.update("waiting", null);
        expect(controller.getSnapshot().slot).toBeNull();
      }
      expect(target.rootProps.initialTaskDraft!.isCurrent!()).toBe(false);
      target.rootProps.initialTaskDraft!.onComplete!();
      expect(complete).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "source-remote-b", "wrong-remote"])(
    "shared Root owner routes a remote project row unread CAS with provided sessionId=%s",
    async (providedSessionId) => {
      const { c, socket } = client();
      const bootstrap = rootRemoteBootstrap();
      bootstrap.mobileViewState = {
        activeWorkspaceKey: "remote:source-b",
        activeTaskId: "source-task-b",
      };
      const controller = rootController(c, bootstrap);
      await flush();
      const opened = socket.opens()[0]!;
      const source = host(socket, opened.bridgeSessionId);
      source.send([INITIALIZE]);
      rootReady(socket, opened, "/workspace-b", {
        kind: "remote",
        workspaceIdentity: "remote:source-b",
        remoteSessionId: "source-remote-b",
      });
      await flush();
      const marking = controller.getSnapshot().slot!.rootProps.webRemoteControlWorkspaceSwitcher!
        .markTaskRead!({
        ...rootTask(),
        workspacePath: "/workspace-b",
        workspaceIdentity: "remote:source-b",
        workspaceKind: "remote",
        taskId: "source-task-b",
        ...(providedSessionId === undefined ? {} : { remoteSessionId: providedSessionId }),
      }).then(
        () => "marked",
        (error: Error) => error.message,
      );
      await flush();
      const mutations = requests(socket, opened.bridgeSessionId).filter(
        (request) =>
          request.header[2] === "window-controller" && request.header[3] === "mutateTask",
      );
      if (providedSessionId === "wrong-remote") {
        expect(mutations).toEqual([]);
        expect(await marking).toBe("mobile-workspace-scope-unavailable");
      } else {
        expect(mutations).toHaveLength(1);
        expect(mutations[0]!.body).toEqual([
          {
            address: {
              workspacePath: "/workspace-b",
              workspaceIdentity: "remote:source-b",
              remoteSessionId: "source-remote-b",
              taskId: "source-task-b",
            },
            mutation: { kind: "mark-read", expectedUnreadAt: 41 },
          },
        ]);
        source.send([SUCCESS, Number(mutations[0]!.header[1])], null);
        expect(await marking).toBe("marked");
      }
    },
  );

  it("shared Root owner registers before slot delivery and keeps a stable Root on inventory refresh", async () => {
    const { c, socket } = client();
    const controller = rootController(c);
    controller.subscribe(() => {
      const slot = controller.getSnapshot().slot;
      if (slot) expect(getRegisteredBaseWorkspaceServices()).toBe(slot.access.services);
    });
    await flush();
    rootReady(socket, socket.opens()[0]!);
    await flush();
    const slot = controller.getSnapshot().slot!;
    expect(slot).toBeTruthy();
    expect(slot.rootProps.services).toBe(slot.access.services);
    expect(slot.rootProps.initialTaskId).toBe("source-task");
    controller.update("paired", { ...rootBootstrap(), tasks: [] });
    expect(controller.getSnapshot().slot).toBe(slot);
    expect(socket.opens()).toHaveLength(1);
    controller.dispose();
    expect(getRegisteredBaseWorkspaceServices()).toBeNull();
    expect(slot.access.isCurrent()).toBe(true);
  });

  it("shared Root owner rejects late window admission and publishes only the new paired target", async () => {
    const { c, socket } = client();
    const controller = rootController(c);
    await flush();
    const old = socket.opens()[0]!;
    controller.update("paired", rootBootstrap("source-window-b", "/workspace-b"));
    await flush();
    expect(socket.opens()).toHaveLength(2);
    rootReady(socket, old);
    await flush();
    expect(controller.getSnapshot().slot).toBeNull();
    rootReady(socket, socket.opens()[1]!);
    await flush();
    expect(controller.getSnapshot().slot?.key).toMatch(/^source-window-b:/u);
    expect(controller.getSnapshot().slot?.rootProps.initialWorkspaceAbsPath).toBe("/workspace-b");
    expect(getRegisteredBaseWorkspaceServices()).toBe(
      controller.getSnapshot().slot?.access.services,
    );
  });

  it("shared Root owner hands an initialization lease to existing task and empty draft before effects run", async () => {
    const { c, socket } = client();
    const controller = rootController(c);
    await flush();
    rootReady(socket, socket.opens()[0]!);
    await flush();
    const task = controller.getSnapshot().slot!;
    expect(task.rootProps.initialTaskDraft?.isCurrent?.()).toBe(true);
    await task.rootProps.webRemoteControlWorkspaceSwitcher!.startDraft!("/workspace");
    const draft = controller.getSnapshot().slot!;
    expect(draft.rootProps.initialTaskId).toBeUndefined();
    expect(draft.rootProps.initialTaskDraft?.isCurrent?.()).toBe(true);
    expect(task.rootProps.initialTaskDraft?.isCurrent?.()).toBe(false);
    socket.close();
    expect(draft.rootProps.initialTaskDraft?.isCurrent?.()).toBe(false);
    expect(controller.getSnapshot().slot).toBeNull();
  });

  it("shared Root owner ignores an old Reporter when the same bridge changes slot", async () => {
    const { c, socket } = client();
    const controller = rootController(c);
    await flush();
    rootReady(socket, socket.opens()[0]!);
    await flush();
    const old = controller.getSnapshot().slot!;
    const switcher = old.rootProps.webRemoteControlWorkspaceSwitcher!;
    await switcher.startDraft!("/workspace", { mobileNavigationIntent: "chat" });
    const current = controller.getSnapshot().slot!;
    expect(current.access.services).toBe(old.access.services);
    expect(current.access.descriptor).toBe(old.access.descriptor);
    expect(old.access.isCurrent()).toBe(true);
    expect(socket.opens()).toHaveLength(1);
    const sent = socket.sent.length;
    await switcher.updateMobileTaskView!(null);
    await switcher.updateMobileViewState!("/workspace", "source-task");
    expect(socket.sent).toHaveLength(sent);
    expect(controller.getSnapshot().slot).toBe(current);
  });

  it("shared Root owner rejects old mark-read without sending a task RPC on a reused bridge", async () => {
    const { c, socket } = client();
    const controller = rootController(c);
    await flush();
    const open = socket.opens()[0]!;
    host(socket, open.bridgeSessionId).send([INITIALIZE]);
    rootReady(socket, open);
    await flush();
    const switcher = controller.getSnapshot().slot!.rootProps.webRemoteControlWorkspaceSwitcher!;
    await switcher.startDraft!("/workspace");
    const marking = switcher.markTaskRead!(rootTask()).catch((error: Error) => error.message);
    await flush();
    expect(requests(socket, open.bridgeSessionId)).toEqual([]);
    expect(await marking).toBe("mobile-workspace-superseded");
  });

  it("shared Root owner rejects old user navigation and reconnect before sending after a slot change", async () => {
    const { c, socket } = client();
    const controller = rootController(c);
    await flush();
    rootReady(socket, socket.opens()[0]!);
    await flush();
    const switcher = controller.getSnapshot().slot!.rootProps.webRemoteControlWorkspaceSwitcher!;
    await switcher.startDraft!("/workspace");
    const sent = socket.sent.length;
    const reconnecting = switcher.reconnectWorkspace!("/workspace").catch(
      (error: Error) => error.message,
    );
    await flush();
    expect(socket.sent).toHaveLength(sent);
    expect(await reconnecting).toBe("mobile-workspace-superseded");
    await expect(switcher.switchWorkspace("/workspace")).rejects.toThrow(
      "mobile-workspace-superseded",
    );
    await expect(switcher.openProjectDraft!({})).rejects.toThrow("mobile-workspace-superseded");
  });

  it("shared Root owner rejects a late list and ignores old subscribers after same-access slot replacement", async () => {
    const { c, socket } = client();
    const onListUpdated = vi.fn();
    const controller = rootController(c, rootBootstrap(), onListUpdated);
    await flush();
    rootReady(socket, socket.opens()[0]!);
    await flush();
    const switcher = controller.getSnapshot().slot!.rootProps.webRemoteControlWorkspaceSwitcher!;
    const listened = vi.fn();
    const unsubscribe = switcher.onWorkspaceListUpdated!(listened);
    const listing = switcher.listWorkspaces().catch((error: Error) => error.message);
    await flush();
    const request = socket.sent.find((payload) => payload.zcode_type === "workspace-list-request")!;
    if (request.zcode_type !== "workspace-list-request") throw new Error("missing-list-request");
    await switcher.startDraft!("/workspace");
    socket.receive({
      zcode_type: "workspace-list-response",
      requestId: request.requestId,
      success: true,
      result: rootList(),
    });
    expect(await listing).toBe("mobile-workspace-superseded");
    expect(onListUpdated).not.toHaveBeenCalled();
    controller.update("paired", rootBootstrap());
    expect(listened).not.toHaveBeenCalled();
    unsubscribe();
    await expect(switcher.listWorkspaces()).rejects.toThrow("mobile-workspace-superseded");
  });

  it("shared Root owner discards an in-flight reconnect response after another slot wins", async () => {
    const { c, socket } = client();
    const controller = rootController(c);
    await flush();
    rootReady(socket, socket.opens()[0]!);
    await flush();
    const switcher = controller.getSnapshot().slot!.rootProps.webRemoteControlWorkspaceSwitcher!;
    const reconnecting = switcher.reconnectWorkspace!("/workspace").catch(
      (error: Error) => error.message,
    );
    await flush();
    const request = socket.sent.find(
      (payload) => payload.zcode_type === "workspace-reconnect-request",
    )!;
    if (request.zcode_type !== "workspace-reconnect-request")
      throw new Error("missing-reconnect-request");
    await switcher.startDraft!("/workspace");
    const current = controller.getSnapshot().slot;
    socket.receive({
      zcode_type: "workspace-reconnect-response",
      requestId: request.requestId,
      workspaceKey: "/workspace",
      success: true,
    });
    await flush();
    expect(
      socket.sent.filter((payload) => payload.zcode_type === "workspace-list-request"),
    ).toEqual([]);
    expect(await reconnecting).toBe("mobile-workspace-superseded");
    expect(controller.getSnapshot().slot).toBe(current);
  });

  it("shared Root owner permits successful reconnect to replace the bridge within the original navigation", async () => {
    const { c, socket } = client();
    const controller = rootController(c);
    await flush();
    const oldOpen = socket.opens()[0]!;
    rootReady(socket, oldOpen);
    await flush();
    const old = controller.getSnapshot().slot!;
    const reconnecting =
      old.rootProps.webRemoteControlWorkspaceSwitcher!.reconnectWorkspace!("/workspace");
    await flush();
    const request = socket.sent.find(
      (payload) => payload.zcode_type === "workspace-reconnect-request",
    )!;
    if (request.zcode_type !== "workspace-reconnect-request")
      throw new Error("missing-reconnect-request");
    socket.receive({
      zcode_type: "bridge-degraded",
      bridgeSessionId: oldOpen.bridgeSessionId,
      reason: "source-host-closed",
    });
    await flush();
    rootReady(socket, socket.opens()[1]!);
    await flush();
    socket.receive({
      zcode_type: "workspace-reconnect-response",
      requestId: request.requestId,
      workspaceKey: "/workspace",
      success: true,
    });
    await flush();
    const list = socket.sent.find((payload) => payload.zcode_type === "workspace-list-request")!;
    if (list.zcode_type !== "workspace-list-request") throw new Error("missing-list-request");
    socket.receive({
      zcode_type: "workspace-list-response",
      requestId: list.requestId,
      success: true,
      result: rootList(),
    });
    await reconnecting;
    expect(controller.getSnapshot().slot?.rootProps.initialTaskId).toBe("source-task");
    expect(controller.getSnapshot().slot?.access).not.toBe(old.access);
    expect(socket.opens()).toHaveLength(2);
  });

  it.each([false, true])(
    "shared Root owner sends target unread CAS after ready and keeps task open when mutation fails=%s",
    async (fail) => {
      const { c, socket } = client();
      const controller = rootController(c, rootRemoteBootstrap());
      await flush();
      const oldOpen = socket.opens()[0]!;
      rootReady(socket, oldOpen);
      await flush();
      const opening = controller
        .getSnapshot()
        .slot!.rootProps.webRemoteControlWorkspaceSwitcher!.switchWorkspace("remote:source-b", {
          taskId: "source-task-b",
          markTaskReadExpectedUnreadAt: 41,
        });
      await flush();
      expect(requests(socket, oldOpen.bridgeSessionId)).toEqual([]);
      const target = socket.opens()[1]!;
      const source = host(socket, target.bridgeSessionId);
      source.send([INITIALIZE]);
      rootReady(socket, target, "/workspace-b", {
        kind: "remote",
        workspaceIdentity: "remote:source-b",
        remoteSessionId: "source-remote-b",
      });
      await flush();
      const mutation = requests(socket, target.bridgeSessionId).find(
        (request) =>
          request.header[2] === "window-controller" && request.header[3] === "mutateTask",
      );
      expect(mutation).toBeDefined();
      expect(mutation!.body).toEqual([
        {
          address: {
            workspacePath: "/workspace-b",
            workspaceIdentity: "remote:source-b",
            remoteSessionId: "source-remote-b",
            taskId: "source-task-b",
          },
          mutation: { kind: "mark-read", expectedUnreadAt: 41 },
        },
      ]);
      source.send(
        [fail ? 202 : SUCCESS, Number(mutation!.header[1])],
        fail ? { name: "Error", message: "controlled-cas-failure" } : null,
      );
      await expect(opening).resolves.toBeUndefined();
      expect(controller.getSnapshot().slot?.rootProps.initialTaskId).toBe("source-task-b");
      expect(requests(socket, oldOpen.bridgeSessionId)).toEqual([]);
    },
  );

  it("shared Root owner does not mark unread from a target slot invalidated during publication", async () => {
    const { c, socket } = client();
    const controller = rootController(c, rootRemoteBootstrap());
    await flush();
    rootReady(socket, socket.opens()[0]!);
    await flush();
    const opening = controller
      .getSnapshot()
      .slot!.rootProps.webRemoteControlWorkspaceSwitcher!.switchWorkspace("remote:source-b", {
        taskId: "source-task-b",
        markTaskReadExpectedUnreadAt: 41,
      });
    await flush();
    const target = socket.opens()[1]!;
    const unsubscribe = controller.subscribe(() => {
      if (controller.getSnapshot().slot?.access.descriptor.workspaceKey === "remote:source-b")
        controller.update("waiting", null);
    });
    host(socket, target.bridgeSessionId).send([INITIALIZE]);
    rootReady(socket, target, "/workspace-b", {
      kind: "remote",
      workspaceIdentity: "remote:source-b",
      remoteSessionId: "source-remote-b",
    });
    await opening;
    expect(requests(socket, target.bridgeSessionId)).toEqual([]);
    expect(controller.getSnapshot().slot).toBeNull();
    unsubscribe();
  });

  it("shared Root owner does not complete a draft on slot publication and fences late target notifications", async () => {
    const { c, socket } = client();
    const controller = rootController(c);
    await flush();
    rootReady(socket, socket.opens()[0]!);
    await flush();
    const current = controller.getSnapshot().slot!;
    const complete = vi.fn();
    let targetCurrent = true;
    const slot = createMobileRootSlot(
      current.access,
      {
        workspaceKey: "/workspace",
        revision: 1,
        draft: { onComplete: complete, isCurrent: () => false },
      },
      "source-window-a",
      unusedPlatform,
      current.rootProps.webRemoteControlWorkspaceSwitcher!,
      () => targetCurrent && current.access.isCurrent(),
    );
    expect(complete).not.toHaveBeenCalled();
    targetCurrent = false;
    slot.rootProps.initialTaskDraft?.onComplete?.();
    expect(complete).not.toHaveBeenCalled();
    targetCurrent = true;
    slot.rootProps.initialTaskDraft?.onComplete?.();
    slot.rootProps.initialTaskDraft?.onComplete?.();
    expect(complete).toHaveBeenCalledTimes(1);
    socket.close();
    expect(slot.rootProps.initialTaskDraft?.isCurrent?.()).toBe(false);
  });

  it("shared Root owner rejects a forced navigation when descriptor path cannot prove the trusted target", async () => {
    const { c, socket } = client();
    const bootstrap = rootBootstrap();
    bootstrap.workspaces.push({
      workspaceKey: "/workspace-b",
      workspacePath: "/workspace-b",
      kind: "local",
    });
    const controller = rootController(c, bootstrap);
    await flush();
    rootReady(socket, socket.opens()[0]!);
    await flush();
    const old = controller.getSnapshot().slot!;
    const navigation = old.rootProps
      .webRemoteControlWorkspaceSwitcher!.switchWorkspace("/workspace-b")
      .catch((error: Error) => error.message);
    await flush();
    rootReady(socket, socket.opens()[1]!, "/unproved-workspace");
    expect(await navigation).toBe("mobile-workspace-navigation-unavailable");
    expect(controller.getSnapshot()).toMatchObject({ slot: null, error: true });
    expect(getRegisteredBaseWorkspaceServices()).toBeNull();
    expect(old.access.isCurrent()).toBe(false);
  });

  it("shared Root borrows the same ready accessor across tasks and invalidates it synchronously", async () => {
    const { c, socket } = client();
    const opening = c.openSharedWorkspace(access);
    await flush();
    const open = socket.opens()[0]!;
    socket.ready(open);
    const first = await opening;
    const nextTask = await c.openSharedWorkspace({ ...access, taskId: "task-a2" });
    expect(nextTask.services).toBe(first.services);
    expect(nextTask.descriptor).toBe(first.descriptor);
    expect(socket.opens()).toHaveLength(1);
    expect(first.isCurrent()).toBe(true);
    const invalidated = vi.fn(() => expect(first.isCurrent()).toBe(false));
    const unsubscribe = c.onSharedWorkspaceInvalidated(invalidated);
    socket.close();
    expect(invalidated).toHaveBeenCalledTimes(1);
    await expect(c.openSharedWorkspace(access)).rejects.toThrow();
    expect(socket.opens()).toHaveLength(1);
    unsubscribe();
    c.dispose();
    expect(invalidated).toHaveBeenCalledTimes(1);
  });

  it("the same remote identity with a new Host route receives a new accessor", async () => {
    const { c, socket } = client();
    const firstOpening = c.openSharedWorkspace({ ...access, remoteSessionId: "remote-a" });
    await flush();
    socket.ready(socket.opens()[0]!, { kind: "remote", remoteSessionId: "remote-a" });
    const first = await firstOpening;
    const secondOpening = c.openSharedWorkspace({ ...access, remoteSessionId: "remote-b" });
    expect(first.isCurrent()).toBe(false);
    await flush();
    socket.ready(socket.opens()[1]!, { kind: "remote", remoteSessionId: "remote-b" });
    const second = await secondOpening;
    expect(second.services).not.toBe(first.services);
    expect(second.generation).toBeGreaterThan(first.generation);
    expect(second.isCurrent()).toBe(true);
  });

  it.each(["workspaceKey", "bridgeSessionId", "bridgeGeneration"] as const)(
    "shared Root rejects a mismatched ready %s before capability or task RPC",
    async (field) => {
      const { c, socket } = client();
      const opening = c.openSharedWorkspace(access).catch((error: Error) => error.message);
      await flush();
      const open = socket.opens()[0]!;
      socket.receive({
        zcode_type: "workspace-bridge-ready",
        requestId: open.requestId,
        bridgeSessionId: open.bridgeSessionId,
        bridge: {
          bridgeSessionId: open.bridgeSessionId,
          bridgeGeneration: open.bridgeGeneration,
          workspaceKey: open.workspaceKey,
          workspacePath: "/workspace",
          kind: "local",
          entryKind: "task",
          capabilities: { windowProjectDirectory: { version: 1 } },
          [field]: field === "bridgeGeneration" ? Number(open.bridgeGeneration) + 1 : "other",
        },
      });
      expect(await opening).toMatch(/scope mismatch/u);
      expect(requests(socket, open.bridgeSessionId)).toEqual([]);
    },
  );

  it("window directory capability uses the pre-open RPC reader and preserves early Initialize", async () => {
    const { c, socket } = client();
    let finished = false;
    const opening = c.ensureWorkspaceBridge(access).then(() => {
      finished = true;
    });
    await flush();
    const open = socket.opens()[0]!;
    const source = host(socket, open.bridgeSessionId);
    source.send([INITIALIZE]);
    socket.receive({
      zcode_type: "workspace-bridge-ready",
      requestId: open.requestId,
      bridgeSessionId: open.bridgeSessionId,
      bridge: {
        bridgeSessionId: open.bridgeSessionId,
        workspaceKey: open.workspaceKey,
        workspacePath: "/workspace",
        kind: "local",
        entryKind: "task",
        capabilities: { windowProjectDirectory: { version: 1 } },
      },
    });
    await flush();
    expect(finished).toBe(false);
    const capability = requests(socket, open.bridgeSessionId).find(
      (request) =>
        request.header[2] === "window-project-changes" && request.header[3] === "getCapabilities",
    );
    expect(capability).toBeDefined();
    source.send([SUCCESS, Number(capability!.header[1])], { version: 1 });
    await opening;
    // 旧测试给 filesystem readDirectory 伪造 tab snapshot，掩盖了真实服务契约错误。
    // 手机目录由共享 Root 读取，这里只验证能力校验保留早到的 Initialize 和原 RPC reader。
    expect(finished).toBe(true);
    expect(
      requests(socket, open.bridgeSessionId).filter((request) =>
        String(request.header[2]).startsWith("window-"),
      ),
    ).toEqual([capability]);
  });

  it("an advertised but missing window directory fails bridge readiness instead of falling back", async () => {
    const { c, socket } = client();
    const opening = c.ensureWorkspaceBridge(access).catch((error: Error) => error.message);
    await flush();
    const open = socket.opens()[0]!;
    const source = host(socket, open.bridgeSessionId);
    source.send([INITIALIZE]);
    socket.receive({
      zcode_type: "workspace-bridge-ready",
      requestId: open.requestId,
      bridgeSessionId: open.bridgeSessionId,
      bridge: {
        bridgeSessionId: open.bridgeSessionId,
        workspaceKey: open.workspaceKey,
        workspacePath: "/workspace",
        kind: "local",
        entryKind: "task",
        capabilities: { windowProjectDirectory: { version: 1 } },
      },
    });
    await flush();
    const capability = requests(socket, open.bridgeSessionId).find(
      (request) => request.header[2] === "window-project-changes",
    );
    expect(capability).toBeDefined();
    source.send([202, Number(capability!.header[1])], {
      name: "Error",
      message: "Unknown channel",
      stack: [],
    });
    expect(await opening).toEqual(expect.any(String));
    expect(
      requests(socket, open.bridgeSessionId).some((request) => request.header[2] === "setting"),
    ).toBe(false);
  });

  it("unsupported window directory versions fail before any directory RPC", async () => {
    const { c, socket } = client();
    const opening = c.ensureWorkspaceBridge(access).catch((error: Error) => error.message);
    await flush();
    const open = socket.opens()[0]!;
    socket.receive({
      zcode_type: "workspace-bridge-ready",
      requestId: open.requestId,
      bridgeSessionId: open.bridgeSessionId,
      bridge: {
        bridgeSessionId: open.bridgeSessionId,
        workspaceKey: open.workspaceKey,
        workspacePath: "/workspace",
        kind: "local",
        entryKind: "task",
        capabilities: { windowProjectDirectory: { version: 2 } },
      },
    });
    expect(await opening).toMatch(/directory|capability/i);
    expect(requests(socket, open.bridgeSessionId)).toEqual([]);
  });

  it("legacy Hosts leave optional window directory absent", async () => {
    const { c, socket } = client();
    const opening = c.ensureWorkspaceBridge(access);
    await flush();
    socket.ready(socket.opens()[0]!);
    await opening;
    expect(
      requests(socket, socket.opens()[0]!.bridgeSessionId).some((request) =>
        String(request.header[2]).startsWith("window-"),
      ),
    ).toBe(false);
  });

  it("changing bridge during a directory capability request rejects the old generation", async () => {
    const { c, socket } = client();
    const first = c.ensureWorkspaceBridge(access).catch((error: Error) => error.message);
    await flush();
    const open = socket.opens()[0]!;
    const source = host(socket, open.bridgeSessionId);
    source.send([INITIALIZE]);
    socket.receive({
      zcode_type: "workspace-bridge-ready",
      requestId: open.requestId,
      bridgeSessionId: open.bridgeSessionId,
      bridge: {
        bridgeSessionId: open.bridgeSessionId,
        workspaceKey: open.workspaceKey,
        workspacePath: "/workspace",
        kind: "local",
        entryKind: "task",
        capabilities: { windowProjectDirectory: { version: 1 } },
      },
    });
    await flush();
    const capability = requests(socket, open.bridgeSessionId).find(
      (request) => request.header[2] === "window-project-changes",
    );
    expect(capability).toBeDefined();
    const second = c.ensureWorkspaceBridge({ workspaceKey: "B" });
    await flush();
    expect(await first).toEqual(expect.any(String));
    const nextOpen = socket.opens().at(-1)!;
    expect(nextOpen.workspaceKey).toBe("B");
    source.send([SUCCESS, Number(capability!.header[1])], { version: 1 });
    socket.ready(nextOpen);
    await second;
    expect(
      requests(socket, nextOpen.bridgeSessionId).some((request) =>
        String(request.header[2]).startsWith("window-"),
      ),
    ).toBe(false);
  });

  it("损坏的 wire 和应用载荷不进入 UI，后续有效请求仍能完成", async () => {
    const { c, socket, onPayload } = client();
    const request = c.request({ zcode_type: "workspace-list-request", requestId: "valid-request" });
    for (const frame of [
      null,
      [],
      { type: "data", payload: null },
      { type: "data", payload: 1 },
      { type: "data", payload: { zcode_type: "workspace-list-updated", result: null } },
      {
        type: "data",
        payload: {
          zcode_type: "workspace-list-response",
          requestId: "valid-request",
          success: true,
        },
      },
    ]) {
      socket.wire(frame);
    }
    await flush();
    expect(onPayload).not.toHaveBeenCalled();
    socket.receive({
      zcode_type: "workspace-list-response",
      requestId: "valid-request",
      success: true,
      result: { workspaces: [], tasks: [], activeWorkspaceKey: "A" },
    });
    expect(await request).toMatchObject({ result: { workspaces: [], tasks: [] } });
  });

  it("RPC 内层字节损坏时立即降级并释放等待 Initialize 的调用", async () => {
    const { c, socket, onPayload } = client();
    const request = c.readTaskSnapshot(access).catch((error: Error) => error.message);
    await flush();
    const open = socket.opens()[0]!;
    socket.ready(open);
    await flush();
    for (const frame of encodeWebRemoteControlRpcFrames(
      { __zcodeBytes: "%%%" },
      { streamId: open.bridgeSessionId, seq: 1 },
    )) {
      socket.receive({ zcode_type: "rpc-frame", frame });
    }
    await flush();
    expect(onPayload).toHaveBeenCalledWith(
      expect.objectContaining({ zcode_type: "bridge-degraded" }),
    );
    expect(await request).toEqual(expect.any(String));
  });

  it("损坏的当前 RPC 帧仍触发降级，旧 stream 的坏帧不影响当前 open", async () => {
    const { c, socket, onPayload } = client();
    const opening = c.ensureWorkspaceBridge(access).catch((error: Error) => error.message);
    await flush();
    socket.wire({
      type: "data",
      payload: { zcode_type: "rpc-frame", frame: { streamId: "old-stream" } },
    });
    expect(onPayload).not.toHaveBeenCalled();
    socket.wire({
      type: "data",
      payload: { zcode_type: "rpc-frame", frame: { streamId: socket.opens()[0]!.bridgeSessionId } },
    });
    await flush();
    expect(onPayload).toHaveBeenCalledWith(
      expect.objectContaining({ zcode_type: "bridge-degraded" }),
    );
    expect(await opening).toEqual(expect.any(String));
  });

  it("ready 前降级立即释放 open 请求并重开，不等待请求超时", async () => {
    const { c, socket } = client();
    const bootstrap = c
      .request({ zcode_type: "bootstrap-request", requestId: "parallel-bootstrap" })
      .catch((error: Error) => error.message);
    const first = c.ensureWorkspaceBridge(access).catch((error: Error) => error.message);
    await flush();
    const oldOpen = socket.opens()[0]!;
    socket.receive({
      zcode_type: "bridge-degraded",
      bridgeSessionId: oldOpen.bridgeSessionId,
      reason: "rpc-transport-fault",
    });
    const recovered = c.ensureWorkspaceBridge(access).catch((error: Error) => error.message);
    await flush();
    expect(socket.opens()).toHaveLength(2);
    socket.ready(oldOpen);
    socket.ready(socket.opens()[1]!);
    expect(await first).toBe("连接已中断，请连接后重试");
    expect(await recovered).toBeUndefined();
    socket.receive({
      zcode_type: "bootstrap-response",
      requestId: "parallel-bootstrap",
      success: true,
      result: {
        windowControlSessionId: "window",
        desktopAppVersion: "test",
        workspaces: [],
        tasks: [],
      },
    });
    expect(await bootstrap).toMatchObject({ zcode_type: "bootstrap-response" });
  });

  it.each([
    ["", "wss://relay.example/ws"],
    ["/remote/socket?route=phone", "wss://relay.example/remote/socket?route=phone"],
  ])("二维码 WS 路径解析：%s", (path, expected) => {
    vi.stubGlobal(
      "location",
      new URL(`https://relay.example/?sid=test&hash=test&wsPath=${encodeURIComponent(path)}`),
    );
    expect(readPairingParamsFromLocation().wsUrl).toBe(expected);
  });

  it.each(["//other.example/ws", "https://other.example/ws", "/\\other.example/ws"])(
    "拒绝跨源 WS 路径：%s",
    (path) => {
      vi.stubGlobal(
        "location",
        new URL(`https://relay.example/?sid=test&hash=test&wsPath=${encodeURIComponent(path)}`),
      );
      expect(() => readPairingParamsFromLocation()).toThrow("路径");
    },
  );

  it("无 crypto.subtle 时仍使用 UTF-8 HMAC-SHA256（含长 key）并与 Node 一致", async () => {
    vi.stubGlobal("crypto", {});
    const params = {
      deviceSid: "sid-手机",
      passHash: "长密钥🌏".repeat(40),
      wsUrl: "ws://localhost/ws",
    };
    const c = new MobileRemoteControlClient(params, {
      onPayload: vi.fn(),
      onStateChange: vi.fn(),
    });
    clients.push(c);
    c.connect();
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    const nonce = "nonce-雪🌙";
    socket.wire({ type: "auth_challenge", nonce });
    await flush();
    const auth = socket.sentWire.find((frame) => frame.type === "auth_response");
    const expected = createHmac("sha256", params.passHash)
      .update(`${nonce}|mobile|${params.deviceSid}`, "utf8")
      .digest("base64url");
    expect(auth?.proof).toBe(expected);
  });

  it.each(["AUTH_FAILED", "KICKED", "WRONG_PARAM"])(
    "%s 错误终止并保留状态，不因 close/重试/重复 connect 复活",
    async (code) => {
      const { c, socket, onStateChange } = client();
      socket.wire({ type: "error", code, message: "stable failure" });
      expect(c.getState()).toBe("error");
      socket.close();
      await vi.advanceTimersByTimeAsync(60_000);
      c.retryNow();
      c.connect();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(c.getState()).toBe("error");
      expect(onStateChange).toHaveBeenLastCalledWith("error", { reason: code });
    },
  );

  it.each([
    [4001, "拒绝"],
    [4002, "互踢"],
    [4003, "配对过期"],
  ])("关闭码 %i 是终止错误（原因：%s）", async (code, reason) => {
    const { c, socket, onStateChange } = client();
    socket.fire("close", { code, reason });
    await vi.advanceTimersByTimeAsync(60_000);
    c.retryNow();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(c.getState()).toBe("error");
    expect(onStateChange).toHaveBeenLastCalledWith("error", {
      reason: code === 4002 ? "KICKED" : code === 4003 ? "AUTH_FAILED" : "CONNECTION_REJECTED",
      closeCode: code,
    });
  });

  it("终止释放在途 bridge 请求，迟到帧不复活且后续请求立即拒绝", async () => {
    const { c, socket } = client();
    const ready = c
      .ensureWorkspaceBridge({ workspaceKey: "A" })
      .catch((error: Error) => error.message);
    await flush();
    const open = socket.opens()[0]!;
    socket.wire({ type: "error", code: "KICKED", message: "proof=should-not-leak" });
    expect(await ready).toBe("KICKED");
    socket.ready(open);
    socket.wire({ type: "auth_ack", pair_status: "matched" });
    socket.fire("error");
    expect(c.getState()).toBe("error");
    await expect(
      c.request({ zcode_type: "bootstrap-request", requestId: "after-stop" }),
    ).rejects.toThrow("mobile connection terminated: KICKED");
  });

  it("未经 auth_ack 的 open 不清退避，pair_status_ack 不清零，auth_ack 才清零", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const c = new MobileRemoteControlClient(
      { deviceSid: "sid", passHash: "hash", wsUrl: "ws://localhost/ws" },
      { onPayload: vi.fn(), onStateChange: vi.fn() },
    );
    clients.push(c);
    c.connect();
    const first = FakeWebSocket.instances[0]!;
    first.open();
    first.close();
    await vi.advanceTimersByTimeAsync(1_000);
    const second = FakeWebSocket.instances[1]!;
    second.open();
    second.wire({ type: "pair_status_ack", pair_status: "waiting" });
    second.close();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    const third = FakeWebSocket.instances[2]!;
    third.open();
    third.wire({ type: "auth_ack", pair_status: "matched" });
    third.close();
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeWebSocket.instances).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it("网络恢复在退避期间立即重连，重复恢复事件与旧定时器不重复建连", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { c, socket } = client();
    socket.close();
    expect(c.getState()).toBe("connecting");
    await vi.advanceTimersByTimeAsync(200);
    c.retryNow();
    expect(FakeWebSocket.instances).toHaveLength(2);
    c.retryNow();
    expect(FakeWebSocket.instances).toHaveLength(2);
    const next = FakeWebSocket.instances[1]!;
    next.open();
    next.wire({ type: "auth_ack", pair_status: "matched" });
    c.retryNow();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(c.getState()).toBe("paired");
  });

  it("Initialize 可先于 ready，replayable 订阅使用真实 RPC，重复物理 seq 只交付一次", async () => {
    const { c, socket } = client();
    let state = conversationReducer(initialConversationState, {
      type: "beginScope",
      scope: access,
    });
    state = conversationReducer(state, { type: "applySnapshot", scope: access, messages: [] });
    const listener = vi.fn((event: ZCodeStreamEvent) => {
      state = conversationReducer(state, { type: "streamEvent", scope: access, event });
    });
    const subscription = c.subscribeTaskStream(access, listener);
    await flush();
    const open = socket.opens()[0]!;
    const desktop = host(socket, open.bridgeSessionId);
    desktop.send([INITIALIZE]);
    socket.ready(open);
    await subscription;
    const listen = requests(socket, open.bridgeSessionId)[0]!;
    expect(listen.seq).toBe(1);
    expect(listen.header[0]).toBe(EVENT_LISTEN);
    expect(listen.header[3]).toBe("onDynamicTaskEvent");
    expect(listen.body).toMatchObject({ deliveryKind: "replayable", taskId: access.taskId });
    const frames = desktop.send([EVENT_FIRE, Number(listen.header[1])], chunk);
    for (const frame of frames) socket.receive({ zcode_type: "rpc-frame", frame });
    desktop.send([EVENT_FIRE, Number(listen.header[1])], chunk);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(state.messages[0]?.text).toBe("haha");
    (await subscription).dispose();
  });

  it("degraded 作废旧 RPC，重新发起 V4 hello/frame RPC", async () => {
    let lifecycle!: TaskConversationLifecycle;
    const { c, socket } = client(
      vi.fn((payload) => {
        if (payload.zcode_type === "bridge-degraded") lifecycle.recoverBridge();
      }),
    );
    const onError = vi.fn();
    lifecycle = new TaskConversationLifecycle(access, {
      prepare: async () => {},
      open: () => c.openTaskConversation(access),
      onState: vi.fn(),
      onError,
    });
    lifecycle.start();
    await flush();
    const first = socket.opens()[0]!;
    const oldHost = host(socket, first.bridgeSessionId);
    oldHost.send([INITIALIZE]);
    socket.ready(first);
    await flush();
    const firstRequests = requests(socket, first.bridgeSessionId);
    expect(firstRequests.some((r) => r.header[3] === "helloConversationV4")).toBe(true);
    expect(firstRequests.some((r) => r.header[3] === "onDynamicConversationFrame")).toBe(true);
    expect(firstRequests.some((r) => r.header[3] === "subscribeConversationV4")).toBe(false);
    socket.receive({
      zcode_type: "bridge-degraded",
      bridgeSessionId: first.bridgeSessionId,
      reason: "rpc-transport-fault",
    });
    await flush();
    expect(socket.opens()).toHaveLength(2);
    const second = socket.opens()[1]!;
    // 旧 bridge 的 Initialize 不可完成新通路；新 bridge 未初始化前没有 V4 RPC。
    oldHost.send([INITIALIZE]);
    socket.ready(second);
    await flush();
    expect(requests(socket, second.bridgeSessionId)).toEqual([]);
    const newHost = host(socket, second.bridgeSessionId);
    newHost.send([INITIALIZE]);
    await flush();
    const secondRequests = requests(socket, second.bridgeSessionId);
    expect(secondRequests.some((r) => r.header[3] === "helloConversationV4")).toBe(true);
    expect(secondRequests.some((r) => r.header[3] === "onDynamicConversationFrame")).toBe(true);
    expect(secondRequests.some((r) => r.header[3] === "subscribeConversationV4")).toBe(false);
    expect(secondRequests.some((r) => r.header[3] === "readSessionMessages")).toBe(false);
    expect(onError).not.toHaveBeenCalled();
    lifecycle.dispose();
  });

  it("remote V4 open preserves path, identity, and remoteSessionId through hello and replayable subscribe", async () => {
    const { c, socket } = client();
    const target = {
      ...access,
      workspaceIdentity: "identity-A",
      remoteSessionId: "remote-A",
    };
    const opening = c.openTaskConversation(target);
    await flush();
    const open = socket.opens()[0]!;
    const desktop = host(socket, open.bridgeSessionId);
    socket.ready(open, { kind: "remote", remoteSessionId: target.remoteSessionId });
    desktop.send([INITIALIZE]);
    const transport = await opening;
    const layer = new SessionDataLayer({ transport, keepWarmMs: 0 });
    const lease = layer.acquire(target.taskId);
    await flush();

    const helloRequest = requests(socket, open.bridgeSessionId).find(
      (request) => request.header[3] === "helloConversationV4",
    );
    expect(helloRequest).toBeDefined();
    desktop.send([SUCCESS, Number(helloRequest!.header[1])], {
      kind: "hello",
      protocolVersion: V4_WIRE_PROTOCOL_VERSION,
      connectionId: "host-connection-A",
      clientMode: "web-remote-replayable",
      deliveryProfile: "replayable",
      serverTime: 1,
      capabilities: {
        nativeDialogs: false,
        localTerminal: false,
        binaryFrames: false,
        compression: "none",
      },
      auth: {},
    });
    await flush();

    const handshakeRequests = requests(socket, open.bridgeSessionId);
    const clientHello = handshakeRequests.find(
      (request) => request.header[3] === "initializeConversationV4",
    );
    expect(
      clientHello,
      `V4 handshake requests: ${JSON.stringify(handshakeRequests)}`,
    ).toBeDefined();
    expect(clientHello!.body).toMatchObject([
      { kind: "clientHello", clientKind: "web", protocolVersion: V4_WIRE_PROTOCOL_VERSION },
    ]);
    desktop.send([SUCCESS, Number(clientHello!.header[1])], {});
    await flush();

    const subscribe = requests(socket, open.bridgeSessionId).find(
      (request) => request.header[3] === "subscribeConversationV4",
    );
    expect(subscribe?.body).toMatchObject([
      {
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        remoteSessionId: target.remoteSessionId,
        sessionId: target.taskId,
      },
    ]);

    const eventListen = requests(socket, open.bridgeSessionId).find(
      (request) =>
        request.header[0] === EVENT_LISTEN && request.header[3] === "onDynamicConversationFrame",
    );
    expect(eventListen?.body).toMatchObject({
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      remoteSessionId: target.remoteSessionId,
    });

    desktop.send([SUCCESS, Number(subscribe!.header[1])], {
      ack: { subscriptionId: "mobile-sub-A", mode: "snapshot", logEpoch: "epoch-A" },
    });
    await flush();
    expect(lease.store.getState()).toMatchObject({
      status: "live",
      subscriptionId: "mobile-sub-A",
      snapshot: null,
    });

    lease.release();
    layer.dispose();
  });

  it("unpaired and closed clients reject V4 conversation open before sending RPC", async () => {
    const { c, socket } = client();
    socket.wire({ type: "pair_status_ack", pair_status: "waiting" });
    await expect(c.openTaskConversation(access)).rejects.toThrow("手机尚未连接");
    socket.wire({ type: "auth_ack", pair_status: "matched" });
    socket.close();
    await expect(c.openTaskConversation(access)).rejects.toThrow("手机尚未连接");
    expect(socket.opens()).toHaveLength(0);
  });

  it("waiting 作废已有 bridge 并立即拒绝 pending RPC，matched 只恢复连接态不自动重放", async () => {
    const { c, socket } = client();
    const ready = c.ensureWorkspaceBridge({ workspaceKey: access.workspaceKey });
    await flush();
    const opened = socket.opens()[0]!;
    socket.ready(opened);
    await ready;
    const desktop = host(socket, opened.bridgeSessionId);
    desktop.send([INITIALIZE]);

    let snapshotResult: string | undefined;
    void c.readTaskSnapshot(access).then(
      () => {
        snapshotResult = "resolved";
      },
      (error: Error) => {
        snapshotResult = error.message;
      },
    );
    let requestResult: string | undefined;
    void c.request({ zcode_type: "bootstrap-request", requestId: "pending-bootstrap" }).then(
      () => {
        requestResult = "resolved";
      },
      (error: Error) => {
        requestResult = error.message;
      },
    );
    await flush();
    expect(
      requests(socket, opened.bridgeSessionId).some((r) => r.header[3] === "readSessionMessages"),
    ).toBe(true);
    expect(socket.sent).toContainEqual({
      zcode_type: "bootstrap-request",
      requestId: "pending-bootstrap",
    });

    socket.wire({ type: "pair_status_ack", pair_status: "waiting" });
    expect(c.getState()).toBe("waiting");
    await flush();
    expect(snapshotResult).toBe("连接已中断，请连接后重试");
    expect(requestResult).toBe("手机尚未连接，请连接后重试");
    await expect(
      c.request({ zcode_type: "bootstrap-request", requestId: "after-waiting" }),
    ).rejects.toThrow("手机尚未连接");
    expect(socket.opens()).toHaveLength(1);

    socket.wire({ type: "pair_status_ack", pair_status: "matched" });
    expect(c.getState()).toBe("paired");
    expect(socket.opens()).toHaveLength(1);
    expect(socket.sent).not.toContainEqual({
      zcode_type: "bootstrap-request",
      requestId: "after-waiting",
    });
  });

  it("waiting→matched 后重启唯一 sweep timer，静默残片超时仍降级", async () => {
    const { c, socket, onPayload } = client();
    socket.wire({ type: "pair_status_ack", pair_status: "waiting" });
    socket.wire({ type: "pair_status_ack", pair_status: "matched" });

    const ready = c.ensureWorkspaceBridge({ workspaceKey: access.workspaceKey });
    await flush();
    const opened = socket.opens()[0]!;
    socket.ready(opened);
    await ready;

    const frames = encodeWebRemoteControlRpcFrames(
      { partial: "x".repeat(1_100_000) },
      { streamId: opened.bridgeSessionId, seq: 1 },
    );
    expect(frames.length).toBeGreaterThan(1);
    socket.receive({ zcode_type: "rpc-frame", frame: frames[0]! });
    await vi.advanceTimersByTimeAsync(
      WEB_REMOTE_CONTROL_RPC_LIMITS.assemblyTimeoutMs +
        WEB_REMOTE_CONTROL_RPC_LIMITS.assemblySweepIntervalMs,
    );

    expect(onPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        zcode_type: "bridge-degraded",
        reason: "buffer-timeout",
      }),
    );
  });

  it("Host Initialize 前的 bridge-degraded 会拒绝挂起快照读取", async () => {
    const { c, socket } = client();
    const ready = c.ensureWorkspaceBridge({ workspaceKey: access.workspaceKey });
    await flush();
    const opened = socket.opens()[0]!;
    socket.ready(opened);
    await ready;
    const read = c.readTaskSnapshot(access).catch((error: Error) => error.message);
    await flush();
    expect(requests(socket, opened.bridgeSessionId)).toEqual([]);
    socket.receive({
      zcode_type: "bridge-degraded",
      bridgeSessionId: opened.bridgeSessionId,
      reason: "rpc-transport-fault",
    });
    expect(await read).toBe("连接已中断，请连接后重试");
  });

  it("手机恢复同一任务保留远端 scope，随后以 replayable 模式订阅", async () => {
    const { c, socket } = client();
    const target = {
      ...access,
      workspaceIdentity: "fixture-identity",
      remoteSessionId: "remote-A",
    };
    const preparing = c.prepareTask(target);
    await flush();
    const open = socket.opens()[0]!;
    const desktop = host(socket, open.bridgeSessionId);
    socket.ready(open, { kind: "remote", remoteSessionId: "remote-A" });
    desktop.send([INITIALIZE]);
    await flush();
    const resume = requests(socket, open.bridgeSessionId)[0]!;
    expect(resume.header[3]).toBe("resumeTask");
    expect(resume.body).toEqual([
      {
        taskId: access.taskId,
        workspacePath: access.workspacePath,
        workspaceIdentity: "fixture-identity",
        remoteSessionId: "remote-A",
      },
    ]);
    desktop.send([SUCCESS, Number(resume.header[1])], {});
    await preparing;
    const subscription = await c.subscribeTaskStream(target, vi.fn());
    const listen = requests(socket, open.bridgeSessionId).find(
      (request) => request.header[0] === EVENT_LISTEN,
    )!;
    expect(listen.body).toMatchObject({
      workspaceIdentity: "fixture-identity",
      remoteSessionId: "remote-A",
      deliveryKind: "replayable",
    });
    subscription.dispose();
  });

  it("deferred A/B/A 的实际 wire open 顺序串行，新桥序号重置且旧帧不进新 client", async () => {
    const { c, socket } = client();
    const readyA = c.ensureWorkspaceBridge({ workspaceKey: "A" });
    await flush();
    const a1 = socket.opens()[0]!;
    const oldHost = host(socket, a1.bridgeSessionId);
    oldHost.send([INITIALIZE]);
    socket.ready(a1);
    await readyA;
    const oldRead = c.readTaskSnapshot(access).catch((error: Error) => error.message);
    await flush();
    const readyB = c
      .ensureWorkspaceBridge({ workspaceKey: "B" })
      .catch((error: Error) => error.message);
    await flush();
    const b = socket.opens()[1]!;
    const readyA2 = c.ensureWorkspaceBridge({ workspaceKey: "A" });
    void readyA2.catch(() => {});
    await flush();
    expect(socket.opens().map((o) => o.workspaceKey)).toEqual(["A", "B", "A"]);
    const lateB = host(socket, b.bridgeSessionId);
    // Host attach 异步：生产 ready 不保证 Initialize 已发送，不能预先见过 B 身份。
    socket.ready(b);
    await flush();
    expect(await readyB).toBe("连接已中断，请连接后重试");
    expect(await oldRead).toBe("连接已中断，请连接后重试");
    expect(socket.opens().map((o) => o.workspaceKey)).toEqual(["A", "B", "A"]);
    const a2 = socket.opens()[2]!;
    lateB.send([INITIALIZE]);
    oldHost.send([INITIALIZE]);
    const newHost = host(socket, a2.bridgeSessionId);
    socket.ready(a2);
    await readyA2;
    const freshRead = c.readTaskSnapshot(access);
    const settled = vi.fn();
    void freshRead.then(settled);
    await flush();
    expect(requests(socket, a2.bridgeSessionId)).toEqual([]);
    expect(settled).not.toHaveBeenCalled();
    newHost.send([INITIALIZE]);
    await flush();
    const read = requests(socket, a2.bridgeSessionId)[0]!;
    expect(read.seq).toBe(1);
    expect(read.header[3]).toBe("readSessionMessages");
    oldHost.send([SUCCESS, Number(read.header[1])], ["stale-a"]);
    lateB.send([SUCCESS, Number(read.header[1])], ["stale-b"]);
    await flush();
    expect(settled).not.toHaveBeenCalled();
    newHost.send([SUCCESS, Number(read.header[1])], []);
    await flush();
    expect(settled).toHaveBeenCalledWith([]);
    expect(await freshRead).toEqual([]);
  });

  it("同一 workspace key 的 remoteSessionId 换代时重开 Host bridge", async () => {
    const { c, socket } = client();
    const firstReady = c.ensureWorkspaceBridge({
      workspaceKey: "remote-workspace",
      remoteSessionId: "remote-A",
    });
    await flush();
    const first = socket.opens()[0]!;
    const oldHost = host(socket, first.bridgeSessionId);
    oldHost.send([INITIALIZE]);
    socket.ready(first, { kind: "remote", remoteSessionId: "remote-A" });
    await firstReady;

    const secondReady = c.ensureWorkspaceBridge({
      workspaceKey: "remote-workspace",
      remoteSessionId: "remote-B",
    });
    await flush();
    expect(socket.opens()).toHaveLength(2);
    const second = socket.opens()[1]!;
    oldHost.send([INITIALIZE]);
    socket.ready(second, { kind: "remote", remoteSessionId: "remote-B" });
    await secondReady;

    const read = c.readTaskSnapshot({
      ...access,
      workspaceKey: "remote-workspace",
      remoteSessionId: "remote-B",
    });
    const readResult = read.then(
      (value) => ({ value }),
      (error: Error) => ({ error: error.message }),
    );
    await flush();
    expect(requests(socket, first.bridgeSessionId)).toEqual([]);
    expect(requests(socket, second.bridgeSessionId)).toEqual([]);
    const newHost = host(socket, second.bridgeSessionId);
    newHost.send([INITIALIZE]);
    await flush();
    const readRequest = requests(socket, second.bridgeSessionId).find(
      (request) => request.header[3] === "readSessionMessages",
    );
    expect(readRequest?.body).toContainEqual(
      expect.objectContaining({ remoteSessionId: "remote-B" }),
    );
    newHost.send([SUCCESS, Number(readRequest?.header[1])], []);
    expect(await readResult).toEqual({ value: [] });
  });

  it("拒绝 remote-A 请求收到 remote-B ready，并允许重试", async () => {
    const { c, socket } = client();
    const target = { workspaceKey: "remote-workspace", remoteSessionId: "remote-A" };
    const firstReady = c.ensureWorkspaceBridge(target).catch((error: Error) => error.message);
    await flush();
    const first = socket.opens()[0]!;
    socket.ready(first, { kind: "remote", remoteSessionId: "remote-B" });
    expect(await firstReady).toBe("workspace bridge scope mismatch");

    const retry = c.ensureWorkspaceBridge(target);
    await flush();
    expect(socket.opens()).toHaveLength(2);
    socket.ready(socket.opens()[1]!, { kind: "remote", remoteSessionId: "remote-A" });
    await retry;
  });

  it.each([
    { kind: "remote" as const, remoteSessionId: "remote-A" },
    { kind: "local" as const, remoteSessionId: "remote-A" },
  ])("本地目标拒绝带 remoteSessionId 的 ready descriptor %#", async (scope) => {
    const { c, socket } = client();
    const opening = c
      .ensureWorkspaceBridge({ workspaceKey: "local-workspace" })
      .catch((error: Error) => error.message);
    await flush();
    socket.ready(socket.opens()[0]!, scope);
    expect(await opening).toBe("workspace bridge scope mismatch");
  });

  it("本地对话工作区接受 conversation ready，不误判为远端 scope", async () => {
    const { c, socket } = client();
    const opening = c.ensureWorkspaceBridge({ workspaceKey: "conversation-workspace" });
    await flush();
    socket.ready(socket.opens()[0]!, { kind: "conversation" });
    await opening;
  });

  it("手机按 open 身份过滤 ack/flow/分片，双向 ack 不串序号空间", async () => {
    const { c, socket, onPayload } = client();
    const listener = vi.fn();
    const subscription = c.subscribeTaskStream(access, listener);
    await flush();
    const open = socket.opens()[0]!;
    socket.ready(open);
    const stale = encodeWebRemoteControlRpcFrames(
      { stale: "x".repeat(1_100_000) },
      {
        streamId: "unknown-retired-bridge",
        seq: 1,
      },
    );
    expect(stale.length).toBeGreaterThan(1);
    for (const frame of [...stale, ...stale]) socket.receive({ zcode_type: "rpc-frame", frame });
    const acknowledge = vi.spyOn(WebRemoteControlRpcReplayBuffer.prototype, "acknowledge");
    socket.receive({
      zcode_type: "rpc-frame",
      frame: { streamId: "unknown-retired-bridge", kind: "ack", seq: 100, ackSeq: 100 },
    });
    socket.receive({
      zcode_type: "rpc-frame",
      frame: { streamId: "unknown-retired-bridge", kind: "flow", seq: 1, flow: "saturated" },
    });
    expect(acknowledge).not.toHaveBeenCalled();
    expect(onPayload).not.toHaveBeenCalled();
    const desktop = host(socket, open.bridgeSessionId);
    desktop.send([INITIALIZE]);
    const handle = await subscription;
    const listen = requests(socket, open.bridgeSessionId)[0]!;
    desktop.send([EVENT_FIRE, Number(listen.header[1])], chunk);
    desktop.send([EVENT_FIRE, Number(listen.header[1])], chunk);
    // 手机出站只有 EventListen(seq=1)，桌面入站已到 EventFire(seq=3)。
    socket.receive({
      zcode_type: "rpc-frame",
      frame: { streamId: open.bridgeSessionId, kind: "ack", seq: 1, ackSeq: 1 },
    });
    expect(acknowledge).toHaveBeenCalledExactlyOnceWith(1, false);
    await vi.advanceTimersByTimeAsync(10);
    expect(
      socket.sent.filter((p) => p.zcode_type === "rpc-frame" && p.frame.kind === "ack"),
    ).toContainEqual({
      zcode_type: "rpc-frame",
      frame: { streamId: open.bridgeSessionId, kind: "ack", seq: 3, ackSeq: 3 },
    });
    // 对端 ack 不可推进本端入站水位；下一条 EventFire(seq=4) 仍正常交付。
    desktop.send([EVENT_FIRE, Number(listen.header[1])], chunk);
    expect(listener).toHaveBeenCalledTimes(3);
    handle.dispose();
    expect(requests(socket, open.bridgeSessionId).at(-1)?.header[0]).toBe(EVENT_DISPOSE);
  });

  it("事件回调同步切桥后，旧消息不能给新桥排 ack", async () => {
    const { c, socket } = client();
    let switching!: Promise<void>;
    const subscription = c.subscribeTaskStream(access, () => {
      switching = c.ensureWorkspaceBridge({ workspaceKey: "B" });
    });
    await flush();
    const first = socket.opens()[0]!;
    const oldHost = host(socket, first.bridgeSessionId);
    oldHost.send([INITIALIZE]);
    socket.ready(first);
    await subscription;
    const listen = requests(socket, first.bridgeSessionId)[0]!;
    oldHost.send([EVENT_FIRE, Number(listen.header[1])], chunk);
    await flush();
    const next = socket.opens()[1]!;
    socket.ready(next);
    await switching;
    await vi.advanceTimersByTimeAsync(10);
    expect(
      socket.sent.filter(
        (payload) =>
          payload.zcode_type === "rpc-frame" &&
          payload.frame.streamId === next.bridgeSessionId &&
          payload.frame.kind === "ack",
      ),
    ).toEqual([]);
  });

  it("INTERNAL 保持临时错误并在断线后自动重试", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { c, socket } = client();
    socket.wire({ type: "error", code: "INTERNAL", message: "temporary" });
    socket.fire("close", { code: 4001, reason: "INTERNAL" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const next = FakeWebSocket.instances[1]!;
    next.open();
    // 新一轮的 4001 不能沿用上一轮 INTERNAL 语义。
    next.fire("close", { code: 4001, reason: "AUTH_FAILED" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(c.getState()).toBe("error");
  });

  it("旧 socket 回调不改新连接状态/信封/RPC", async () => {
    const { c, socket, onPayload } = client();
    socket.close();
    await vi.advanceTimersByTimeAsync(2000);
    const next = FakeWebSocket.instances.at(-1)!;
    expect(next).not.toBe(socket);
    next.open();
    next.wire({ type: "auth_ack", pair_status: "matched" });
    socket.wire({ type: "pair_status_ack", pair_status: "waiting" });
    socket.receive({ zcode_type: "app-error", reason: "unexpectedError", error: "stale" });
    await flush();
    expect(c.getState()).toBe("paired");
    expect(onPayload).not.toHaveBeenCalled();
  });

  it("加速重连换代旧 socket 后，新连接必须重开 bridge", async () => {
    const { c, socket, onPayload } = client();
    const ready = c.ensureWorkspaceBridge({ workspaceKey: access.workspaceKey });
    await flush();
    const oldOpen = socket.opens()[0]!;
    const oldHost = host(socket, oldOpen.bridgeSessionId);
    oldHost.send([INITIALIZE]);
    socket.ready(oldOpen);
    await ready;

    const oldRead = c.readTaskSnapshot(access).catch((error: Error) => error.message);
    await flush();
    expect(
      requests(socket, oldOpen.bridgeSessionId).some(
        (request) => request.header[3] === "readSessionMessages",
      ),
    ).toBe(true);

    // 浏览器在 close 回调前可能暴露 error 并允许恢复事件加速重连。
    socket.fire("error");
    socket.readyState = 2;
    c.retryNow();
    const next = FakeWebSocket.instances.at(-1)!;
    expect(next).not.toBe(socket);
    expect(socket.opens()).toHaveLength(1);
    expect(await oldRead).toBe("连接已中断，请连接后重试");

    next.open();
    next.wire({ type: "auth_ack", pair_status: "matched" });
    socket.close();
    socket.wire({ type: "error", code: "INTERNAL", message: "stale" });
    expect(c.getState()).toBe("paired");
    expect(onPayload).not.toHaveBeenCalled();

    const reopened = c.ensureWorkspaceBridge(access);
    await flush();
    const newOpen = next.opens()[0]!;
    expect(socket.opens()).toHaveLength(1);
    expect(newOpen.bridgeSessionId).not.toBe(oldOpen.bridgeSessionId);
    const newHost = host(next, newOpen.bridgeSessionId);
    newHost.send([INITIALIZE]);
    next.ready(newOpen);
    await reopened;

    socket.wire({
      type: "data",
      payload: {
        zcode_type: "bridge-degraded",
        bridgeSessionId: oldOpen.bridgeSessionId,
        reason: "rpc-transport-fault",
      },
    });
    await c.ensureWorkspaceBridge(access);
    await flush();
    expect(c.getState()).toBe("paired");
    expect(next.opens()).toHaveLength(1);
    expect(onPayload).not.toHaveBeenCalled();
  });
});
