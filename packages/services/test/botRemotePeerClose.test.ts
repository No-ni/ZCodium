import { EventEmitter, once } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { ChannelServer, Event, MessagePortProtocol } from "@zcode/rpc";
import { createBotRemoteWorkspaceService } from "../src/bots/botRemoteWorkspaceBridge.js";
import { createRemoteRuntimeServicesFromPort } from "../src/bots/botRemoteRuntimeServices.js";
import { IModelSelectionService } from "../src/model-provider/providerFacadeServices.js";
import { IZCodeAgentService } from "../src/zcode-agent/zcodeAgent.js";

const target = { workspacePath: "C:/synthetic/review", workspaceIdentity: "synthetic-review" };
function fixture() {
  const parent = Object.assign(new EventEmitter(), { postMessage: vi.fn() });
  const create = () =>
    createBotRemoteWorkspaceService({
      parentPort: parent,
      settingService: {
        get: async () => ({
          lastWorkspaceSession: [{ kind: "remote", ...target, target: { kind: "local" } }],
        }),
      },
      credentialService: { load: async () => null },
    } as unknown as Parameters<typeof createBotRemoteWorkspaceService>[0])!;
  return { parent, create, service: create() };
}
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function rpcPeer(view = async () => ({}), preferences = async () => {}) {
  const { port1, port2 } = new MessageChannel();
  const protocol = new MessagePortProtocol(port2);
  const server = new ChannelServer(protocol, "synthetic");
  server.registerChannel(IModelSelectionService.channelName, {
    call: view,
    listen: () => Event.None,
  });
  server.registerChannel(IZCodeAgentService.channelName, {
    call: preferences,
    listen: () => Event.None,
  });
  return {
    port: port1,
    close() {
      server.dispose();
      protocol.disconnect();
    },
  };
}

it.each(["view", "preferences"])("rejects peer closure during %s initialization", async (stage) => {
  const f = fixture();
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = () => {
    entered();
    return new Promise<never>(() => {});
  };
  const peer = rpcPeer(
    stage === "view" ? pending : undefined,
    stage === "preferences" ? pending : undefined,
  );
  f.parent.postMessage.mockImplementation((message) => {
    f.parent.emit("message", {
      data: { type: "bot-remote-workspace-runtime-port", requestId: message.requestId, ok: true },
      ports: [peer.port],
    });
  });
  try {
    const result = f.service.getModelSelectionService(target).catch((error: unknown) => error);
    await waiting;
    const closed = once(peer.port, "close");
    peer.close();
    await closed;
    expect(await result).toMatchObject({ name: "ConnectionClosed" });
  } finally {
    f.service.dispose();
    peer.close();
  }
});

it("does not evict the current adapter when an older concurrent adapter closes", async () => {
  const f = fixture();
  const peers: ReturnType<typeof rpcPeer>[] = [];
  f.parent.postMessage.mockImplementation((message) => {
    const peer = rpcPeer();
    peers.push(peer);
    f.parent.emit("message", {
      data: { type: "bot-remote-workspace-runtime-port", requestId: message.requestId, ok: true },
      ports: [peer.port],
    });
  });
  try {
    const services = await Promise.all([
      f.service.getModelSelectionService(target),
      f.service.getModelSelectionService(target),
    ]);
    expect(peers).toHaveLength(2);
    const current = await f.service.getModelSelectionService(target);
    const old = peers[services[0] === current ? 1 : 0]!;
    const closed = once(old.port, "close");
    old.close();
    await closed;
    expect(await f.service.getModelSelectionService(target)).toBe(current);
    expect(peers).toHaveLength(2);
    expect(await current!.getView()).toEqual({});
  } finally {
    f.service.dispose();
    for (const peer of peers) peer.close();
  }
});

it("routes to a live bridge and closes surplus, duplicate, malformed and unclaimed ports", async () => {
  const f = fixture();
  const second = f.create();
  f.service.dispose();
  const peer = rpcPeer();
  const extra = { close: vi.fn() };
  let requestId!: string;
  f.parent.postMessage.mockImplementation((message) => {
    requestId = message.requestId;
    f.parent.emit("message", {
      data: { type: "bot-remote-workspace-runtime-port", requestId, ok: true },
      ports: [peer.port, extra],
    });
  });
  try {
    expect(await second.getModelSelectionService(target)).not.toBeNull();
    expect(extra.close).toHaveBeenCalledOnce();
    for (const data of [
      { type: "bot-remote-workspace-runtime-port", requestId, ok: true },
      { type: "bot-remote-workspace-runtime-port", requestId, ok: "malformed" },
      { type: "bot-remote-workspace-runtime-port", requestId: "unknown", ok: false },
    ]) {
      const ports = [{ close: vi.fn() }, { close: vi.fn() }];
      f.parent.emit("message", { data, ports });
      for (const port of ports) expect(port.close).toHaveBeenCalledOnce();
    }
    expect(f.parent.listenerCount("message")).toBe(1);
  } finally {
    second.dispose();
    peer.close();
  }
});

it.each([false, true])("settles real peer closure (initialized=%s)", async (initialized) => {
  const { port1, port2 } = new MessageChannel();
  const services = createRemoteRuntimeServicesFromPort(port1);
  const protocol = new MessagePortProtocol(port2);
  const server = initialized ? new ChannelServer(protocol, "synthetic") : undefined;
  const result = services.modelSelectionService.getView().catch((error: unknown) => error);
  try {
    await nextTurn();
    const closed = once(port1, "close");
    server?.dispose();
    protocol.disconnect();
    await closed;
    await nextTurn();
    expect(await Promise.race([result, Promise.resolve("pending")])).toMatchObject({
      name: "ConnectionClosed",
    });
  } finally {
    services.dispose();
    server?.dispose();
    port2.close();
  }
});

it("replaces a closed cached adapter after reconnect", async () => {
  const f = fixture();
  const peers: {
    port: MessageChannel["port2"];
    server: ChannelServer<string>;
    protocol: MessagePortProtocol;
  }[] = [];
  f.parent.postMessage.mockImplementation((message) => {
    if (message.type === "bot-remote-workspace-reconnect-request") {
      f.parent.emit("message", {
        data: {
          type: "bot-remote-workspace-reconnect-result",
          requestId: message.requestId,
          ok: true,
        },
      });
      return;
    }
    const { port1, port2 } = new MessageChannel();
    const protocol = new MessagePortProtocol(port2);
    const server = new ChannelServer(protocol, "synthetic");
    server.registerChannel(IModelSelectionService.channelName, {
      call: async () => ({}),
      listen: () => Event.None,
    });
    server.registerChannel(IZCodeAgentService.channelName, {
      call: async () => undefined,
      listen: () => Event.None,
    });
    peers.push({ port: port1, server, protocol });
    f.parent.emit("message", {
      data: { type: "bot-remote-workspace-runtime-port", requestId: message.requestId, ok: true },
      ports: [port1],
    });
  });
  try {
    const first = await f.service.getModelSelectionService(target);
    const closed = once(peers[0]!.port, "close");
    peers[0]!.server.dispose();
    peers[0]!.protocol.disconnect();
    await closed;
    await f.service.ensureConnected(target);
    const second = await f.service.getModelSelectionService(target);
    expect(second === first).toBe(false);
    expect(peers).toHaveLength(2);
    expect(await second!.getView()).toEqual({});
  } finally {
    f.service.dispose();
    for (const p of peers) {
      p.server.dispose();
      p.protocol.disconnect();
    }
  }
});

it.each(["timeout", "dispose"])(
  "closes ports arriving after %s and keeps one transport listener",
  async (reason) => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      const result = f.service.getZCodeTaskService(target).catch((error: unknown) => error);
      await flush();
      const requestId = f.parent.postMessage.mock.calls[0]![0].requestId;
      if (reason === "timeout") await vi.advanceTimersByTimeAsync(60_000);
      else f.service.dispose();
      await result;
      const close = vi.fn();
      f.parent.emit("message", {
        data: { type: "bot-remote-workspace-runtime-port", requestId, ok: true },
        ports: [{ close }],
      });
      expect(close).toHaveBeenCalledOnce();
      for (let i = 0; i < 100; i++) f.create().dispose();
      expect(f.parent.listenerCount("message")).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      f.service.dispose();
      vi.useRealTimers();
    }
  },
);
