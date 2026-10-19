import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppSettings,
  WebRemoteControlStatusSnapshot,
  WebRemoteControlWorkspaceRef,
} from "@zcode/shared";
import { HostMessageTypes, webRemoteControlClientToEndpointFrameSchema } from "@zcode/shared";
import type { ICredentialService, ISettingService } from "@zcode/services";
import { WebSocket, WebSocketServer } from "ws";
import { createWebRemoteControlManager } from "./manager.js";
import type { WebRemoteControlLogger } from "./logger.js";
import { LanRemoteControlEndpoint } from "./lanEndpoint.js";

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class Port extends EventEmitter {
    start() {}
    postMessage() {}
    close() {
      this.emit("close");
    }
  }
  return {
    BrowserWindow: { fromId: (id: number) => ({ webContents: { id } }) },
    MessageChannelMain: class {
      port1 = new Port();
      port2 = new Port();
    },
  };
});

const PASS_HASH_CREDENTIAL_KEY = "web-remote-control:external-relay:pass_hash";

interface RelayPair {
  deviceSid: string;
  passHash: string;
  device?: WebSocket;
  mobile?: WebSocket;
}

interface RelaySocketState {
  role?: "device" | "mobile";
  deviceSid?: string;
  pending?: { role: "device" | "mobile"; deviceSid: string; nonce: string };
  pair?: RelayPair;
}

interface MobileConnection {
  socket: WebSocket;
  frames: Array<Record<string, unknown>>;
}

const logger: WebRemoteControlLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe("createWebRemoteControlManager multi-window relay identity", () => {
  let httpServer: ReturnType<typeof createServer>;
  let relay: WebSocketServer;
  let port: number;
  let settings: Partial<AppSettings>;
  let credentials: Map<string, string>;
  let pairs: Map<string, RelayPair>;
  let registrationCount: number;
  let nonceCount: number;
  let manager: ReturnType<typeof createWebRemoteControlManager>;
  let mobileConnections: MobileConnection[];
  let startedWindowIds: number[];
  let beforeSettingsRead: (() => Promise<void>) | undefined;
  let beforeAuthAck: Promise<void> | undefined;
  let beforeSettingsUpdate: ((patch: Partial<AppSettings>) => Promise<void>) | undefined;
  let beforeCredentialDelete: (() => Promise<void>) | undefined;
  let beforeCredentialSave: (() => Promise<void>) | undefined;
  let statuses: Array<{ windowId: number; snapshot: WebRemoteControlStatusSnapshot }>;
  let lanEndpoints: Set<LanRemoteControlEndpoint>;
  let hostMessages: Array<Record<string, unknown>>;

  beforeEach(async () => {
    settings = {
      webRemoteControlEndpointMode: "custom",
      webRemoteControlCustomEndpointUrl: "",
    };
    credentials = new Map();
    pairs = new Map();
    registrationCount = 0;
    nonceCount = 0;
    mobileConnections = [];
    startedWindowIds = [];
    beforeSettingsRead = undefined;
    beforeAuthAck = undefined;
    beforeSettingsUpdate = undefined;
    beforeCredentialDelete = undefined;
    beforeCredentialSave = undefined;
    statuses = [];
    lanEndpoints = new Set();
    hostMessages = [];
    const startEndpoint = LanRemoteControlEndpoint.prototype.start;
    vi.spyOn(LanRemoteControlEndpoint.prototype, "start").mockImplementation(
      function (this: LanRemoteControlEndpoint) {
        lanEndpoints.add(this);
        return startEndpoint.call(this);
      },
    );

    httpServer = createServer();
    relay = new WebSocketServer({ server: httpServer, path: "/ws" });
    relay.on("connection", (socket) => {
      const state: RelaySocketState = {};
      socket.on("message", async (raw) => {
        const parsed = webRemoteControlClientToEndpointFrameSchema.safeParse(
          JSON.parse(raw.toString()),
        );
        if (!parsed.success) {
          socket.close(4001, "WRONG_PARAM");
          return;
        }
        const frame = parsed.data;

        if (frame.type === "device_register_init") {
          const deviceSid = `manager-test-sid-${++registrationCount}`;
          const pair: RelayPair = { deviceSid, passHash: frame.pass_hash };
          pairs.set(deviceSid, pair);
          socket.send(JSON.stringify({ type: "device_register_ack", device_sid: deviceSid }));
          return;
        }

        if (frame.type === "auth_init") {
          const pair = pairs.get(frame.device_sid);
          if (!pair) {
            socket.send(JSON.stringify({ type: "error", code: "AUTH_FAILED" }));
            socket.close(4001, "AUTH_FAILED");
            return;
          }
          const nonce = `manager-test-nonce-${++nonceCount}`;
          state.pending = { role: frame.role, deviceSid: frame.device_sid, nonce };
          socket.send(JSON.stringify({ type: "auth_challenge", nonce }));
          return;
        }

        if (frame.type === "auth_response") {
          const pending = state.pending;
          state.pending = undefined;
          const pair = pending && pairs.get(pending.deviceSid);
          const expected =
            pending && pair
              ? createHmac("sha256", pair.passHash)
                  .update(`${pending.nonce}|${pending.role}|${pending.deviceSid}`)
                  .digest("base64url")
              : "";
          if (
            !pending ||
            !pair ||
            frame.device_sid !== pending.deviceSid ||
            frame.proof !== expected
          ) {
            socket.send(JSON.stringify({ type: "error", code: "AUTH_FAILED" }));
            socket.close(4001, "AUTH_FAILED");
            return;
          }

          const previous = pending.role === "device" ? pair.device : pair.mobile;
          if (previous && previous !== socket) previous.close(4002, "role-replaced");
          state.role = pending.role;
          state.deviceSid = pending.deviceSid;
          state.pair = pair;
          if (pending.role === "device") pair.device = socket;
          else pair.mobile = socket;

          const pairStatus = isPaired(pair) ? "matched" : "waiting";
          await beforeAuthAck;
          if (socket.readyState !== WebSocket.OPEN) return;
          socket.send(JSON.stringify({ type: "auth_ack", pair_status: pairStatus }));
          const peer = pending.role === "device" ? pair.mobile : pair.device;
          if (peer) peer.send(JSON.stringify({ type: "pair_status_ack", pair_status: pairStatus }));
          return;
        }

        if (frame.type === "data") {
          const pair = state.pair;
          if (
            !pair ||
            !state.role ||
            !isCurrentBinding(pair, state.role, socket) ||
            !isPaired(pair)
          ) {
            return;
          }
          const target = state.role === "device" ? pair.mobile : pair.device;
          target?.send(JSON.stringify({ type: "data", payload: frame.payload }));
          return;
        }

        if (
          frame.type === "device_unregister" &&
          state.role === "device" &&
          state.deviceSid === frame.device_sid &&
          state.pair?.device === socket
        ) {
          const pair = state.pair;
          pairs.delete(pair.deviceSid);
          pair.mobile?.close(4003, "pair-expired");
          pair.device = undefined;
          pair.mobile = undefined;
        }
      });

      socket.on("close", () => {
        const pair = state.pair;
        if (!pair || !state.role || !isCurrentBinding(pair, state.role, socket)) return;
        if (state.role === "device") pair.device = undefined;
        else pair.mobile = undefined;
        const peer = state.role === "device" ? pair.mobile : pair.device;
        if (peer) peer.send(JSON.stringify({ type: "pair_status_ack", pair_status: "waiting" }));
      });
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    port = (httpServer.address() as { port: number }).port;
    settings.webRemoteControlCustomEndpointUrl = `ws://127.0.0.1:${port}/ws`;

    const settingService: ISettingService = {
      async get() {
        await beforeSettingsRead?.();
        return settings as AppSettings;
      },
      async update(patch) {
        await beforeSettingsUpdate?.(patch);
        Object.assign(settings, patch);
      },
      async updateDataBaseDir() {},
      async ensureDefaultProject(homedir) {
        return { path: homedir, created: false };
      },
    };
    const credentialService: ICredentialService = {
      async load(key) {
        return credentials.get(key) ?? null;
      },
      async save(key, value) {
        await beforeCredentialSave?.();
        credentials.set(key, value);
      },
      async delete(key) {
        await beforeCredentialDelete?.();
        credentials.delete(key);
      },
    };
    manager = createWebRemoteControlManager({
      logger,
      settingService,
      credentialService,
      deviceMid: "manager-test-mid",
      deviceName: "manager-test-device",
      appVersion: "0.0.0-test",
      onStatusChanged: (windowId, snapshot) => statuses.push({ windowId, snapshot }),
      handlePlatformRequest: async () => undefined,
      reconnectWorkspace: async () => undefined,
      // 真实 manager/bridge 调度，Host 进程与 Electron 端口使用受控 fixture。
      resolveHostProcess: () => ({
        postMessage: (message) => hostMessages.push(message as Record<string, unknown>),
      }),
    });
  });

  afterEach(async () => {
    for (const windowId of [...startedWindowIds].reverse()) {
      await manager.disposeWindow(windowId);
    }
    for (const connection of mobileConnections) connection.socket.terminate();
    for (const client of relay.clients) client.terminate();
    for (const endpoint of lanEndpoints) await endpoint.stop();
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it("凭据保存失败被处理并脱敏，当前内存配对仍可 bootstrap", async () => {
    const warning = vi.spyOn(logger, "warn");
    beforeCredentialSave = async () => {
      throw new Error("synthetic-private-storage-detail");
    };
    const status = await startWindow(57, "C:/workspace/save-failure");
    await waitFor(
      () =>
        warning.mock.calls.find(
          ([message]) => typeof message === "string" && message.includes("auth persistence failed"),
        ),
      "handled persistence failure",
    );
    const qr = new URL(status.qrUrl!);
    const mobile = await connectMobile(status.sessionId!, qr.searchParams.get("hash")!);
    expect((await requestBootstrap(mobile, "after-save-failure")).result).toMatchObject({
      windowControlSessionId: status.sessionId,
    });
    expect(JSON.stringify(warning.mock.calls)).not.toContain("synthetic-private-storage-detail");
    expect(JSON.stringify(warning.mock.calls)).not.toContain(qr.searchParams.get("hash")!);
  });

  it("keeps each active window's SID, bootstrap routing, and stop isolated", async () => {
    const windowA = await startWindow(1, "C:/workspace/window-a");
    manager.syncWorkspaces(1, [workspace("window-a")]);
    await waitFor(
      () =>
        settings.webRemoteControlExternalRelayDevice?.deviceSid === windowA.sessionId &&
        credentials.has(PASS_HASH_CREDENTIAL_KEY),
      "window A registration persistence",
    );

    const windowB = await startWindow(2, "C:/workspace/window-b");
    manager.syncWorkspaces(2, [workspace("window-b")]);

    expect(windowA.sessionId).toBeTruthy();
    expect(windowB.sessionId).toBeTruthy();
    expect(windowB.sessionId).not.toBe(windowA.sessionId);
    expect(pairs.get(windowB.sessionId!)?.passHash).not.toBe(
      pairs.get(windowA.sessionId!)?.passHash,
    );

    const mobileA = await connectMobile(windowA.sessionId!);
    await waitFor(() => manager.getStatus(1).mobileConnected === true, "window A mobile pairing");
    const mobileB = await connectMobile(windowB.sessionId!);
    await waitFor(() => manager.getStatus(2).mobileConnected === true, "window B mobile pairing");

    expect((await requestBootstrap(mobileA, "bootstrap-a-1")).result).toMatchObject({
      workspaces: [expect.objectContaining({ workspaceKey: "window-a" })],
    });
    expect((await requestBootstrap(mobileB, "bootstrap-b-1")).result).toMatchObject({
      workspaces: [expect.objectContaining({ workspaceKey: "window-b" })],
    });

    await manager.disposeWindow(2);
    await waitFor(() => !pairs.has(windowB.sessionId!), "window B relay unregister");
    expect(manager.getStatus(1).mobileConnected).toBe(true);
    expect((await requestBootstrap(mobileA, "bootstrap-a-after-stop-b")).result).toMatchObject({
      workspaces: [expect.objectContaining({ workspaceKey: "window-a" })],
    });
  });

  it.each(["lan-disconnect", "lan-replace", "relay-disconnect", "relay-error"])(
    "detaches the old Host immediately on transport loss: %s",
    async (scenario) => {
      const lan = scenario.startsWith("lan");
      settings.webRemoteControlEndpointMode = lan ? "lan" : "custom";
      const status = await startWindow(55, "C:/workspace/loss");
      manager.syncWorkspaces(55, [workspace("loss")]);
      const qr = new URL(status.qrUrl!);
      const mobileUrl = lan ? `ws://127.0.0.1:${qr.port}/ws` : undefined;
      const mobile = await connectMobile(
        status.sessionId!,
        qr.searchParams.get("hash")!,
        mobileUrl,
      );
      mobile.socket.send(
        JSON.stringify({
          type: "data",
          payload: {
            zcode_type: "workspace-bridge-open",
            requestId: "open-loss",
            bridgeSessionId: "loss-bridge",
            workspaceKey: "loss",
          },
        }),
      );
      await waitFor(
        () => hostMessages.find((message) => message.type === HostMessageTypes.AttachServicePort),
        "Host attach",
      );
      if (scenario === "lan-replace") {
        const replacement = await connectMobile(
          status.sessionId!,
          qr.searchParams.get("hash")!,
          mobileUrl,
        );
        await requestBootstrap(replacement, "replacement-bootstrap");
      } else if (scenario === "relay-error") {
        pairs.get(status.sessionId!)!.device!.terminate();
      } else {
        mobile.socket.terminate();
      }
      await waitFor(
        () => hostMessages.find((message) => message.type === HostMessageTypes.DetachServicePort),
        "Host detach before grace expires",
      );
      expect(
        hostMessages.filter((message) => message.type === HostMessageTypes.DetachServicePort),
      ).toHaveLength(1);
    },
  );

  it("restores LAN bootstrap routing when restarting a paired persistent SID", async () => {
    settings.webRemoteControlEndpointMode = "lan";
    const initial = await startWindow(51, "C:/workspace/lan-restart");
    const qr = new URL(initial.qrUrl!);
    const mobile = await connectMobile(
      initial.sessionId!,
      qr.searchParams.get("hash")!,
      `ws://127.0.0.1:${qr.port}/ws`,
    );
    await waitFor(
      () => settings.webRemoteControlExternalRelayDevice?.deviceSid === initial.sessionId,
      "LAN credentials persisted",
    );
    await requestBootstrap(mobile, "before-restart");
    await manager.stop(51);
    const restored = await startWindow(51, "C:/workspace/lan-restart");
    expect(restored.sessionId).toBe(initial.sessionId);
    manager.syncWorkspaces(51, [workspace("lan-restart")]);
    expect((await requestBootstrap(mobile, "after-restart")).result).toMatchObject({
      workspaces: [expect.objectContaining({ workspaceKey: "lan-restart" })],
    });
  });

  it("carries the configured relay WS path and query in the QR URL", async () => {
    relay.options.path = "/remote/socket";
    settings.webRemoteControlCustomEndpointUrl = `ws://127.0.0.1:${port}/remote/socket?route=phone`;
    const status = await startWindow(52, "C:/workspace/custom-ws-path");
    const qr = new URL(status.qrUrl!);
    expect(qr.searchParams.get("wsPath")).toBe("/remote/socket?route=phone");
    const mobileUrl = new URL(qr.searchParams.get("wsPath")!, `ws://${qr.host}`).toString();
    const mobile = await connectMobile(status.sessionId!, qr.searchParams.get("hash")!, mobileUrl);
    expect((await requestBootstrap(mobile, "custom-ws-path")).result).toMatchObject({
      windowControlSessionId: status.sessionId,
    });
  });

  it.each([
    { remoteSessionId: undefined, workspaceIdentity: "remote-identity" },
    { remoteSessionId: " ", workspaceIdentity: "remote-identity" },
    { remoteSessionId: "remote-session", workspaceIdentity: undefined },
    { remoteSessionId: "remote-session", workspaceIdentity: " " },
  ])("rejects incomplete remote scopes before creating any Host attachment: %j", async (scope) => {
    const status = await startWindow(54, "C:/workspace/remote-scope");
    manager.syncWorkspaces(54, [
      { ...workspace("remote-scope"), kind: "remote", connectionState: "connected", ...scope },
    ]);
    const mobile = await connectMobile(status.sessionId!);
    mobile.socket.send(
      JSON.stringify({
        type: "data",
        payload: {
          zcode_type: "workspace-bridge-open",
          requestId: "invalid-remote-scope",
          bridgeSessionId: "invalid-scope-bridge",
          workspaceKey: "remote-scope",
        },
      }),
    );
    const response = await waitFor(
      () =>
        mobile.frames.find(
          (frame) =>
            (frame.payload as { requestId?: string } | undefined)?.requestId ===
            "invalid-remote-scope",
        ),
      "scope response",
    );
    expect(response.payload).toMatchObject({
      zcode_type: "workspace-bridge-error",
      reason: "invalidMobileConnection",
    });
    expect(hostMessages).toHaveLength(0);
  });

  it.each([
    "removed",
    "removed-local",
    "path",
    "identity",
    "remote-session",
    "kind",
    "disconnected",
  ])("releases the attached workspace bridge after scope change: %s", async (change) => {
    const status = await startWindow(53, "C:/workspace/bridge-scope");
    const original: WebRemoteControlWorkspaceRef = {
      ...workspace("bridge-scope"),
      workspaceIdentity: "scope-identity",
      remoteSessionId: "remote-a",
      kind: "remote",
      connectionState: "connected",
    };
    if (change === "removed-local") {
      original.kind = "local";
      original.workspaceIdentity = undefined;
      original.remoteSessionId = undefined;
    }
    manager.syncWorkspaces(53, [original]);
    const mobile = await connectMobile(status.sessionId!);
    mobile.socket.send(
      JSON.stringify({
        type: "data",
        payload: {
          zcode_type: "workspace-bridge-open",
          requestId: "scope-open",
          bridgeSessionId: "scope-bridge",
          workspaceKey: original.workspaceKey,
        },
      }),
    );
    await waitFor(
      () => hostMessages.find((message) => message.type === HostMessageTypes.AttachServicePort),
      "Host attachment",
    );
    manager.syncWorkspaces(53, [{ ...original, label: "renamed" }]);
    expect(
      hostMessages.some((message) => message.type === HostMessageTypes.DetachServicePort),
    ).toBe(false);
    const changed = { ...original };
    if (change === "path") changed.workspacePath = "C:/workspace/replaced";
    if (change === "identity") changed.workspaceIdentity = "other-identity";
    if (change === "remote-session") changed.remoteSessionId = "remote-b";
    if (change === "kind") changed.kind = "local";
    if (change === "disconnected") changed.connectionState = "disconnected";
    manager.syncWorkspaces(53, change.startsWith("removed") ? [] : [changed]);
    expect(hostMessages).toContainEqual(
      expect.objectContaining({ type: HostMessageTypes.DetachServicePort }),
    );
    await waitFor(
      () =>
        mobile.frames.find(
          (frame) =>
            (frame.payload as Record<string, unknown> | undefined)?.zcode_type ===
            "bridge-degraded",
        ),
      "bridge invalidation notification",
    );
  });

  it("assigns one fresh SID when two windows start from the same persisted pair", async () => {
    const persistedSid = "manager-test-persisted-sid";
    const persistedPassHash = "manager-test-persisted-pass-hash";
    pairs.set(persistedSid, { deviceSid: persistedSid, passHash: persistedPassHash });
    settings.webRemoteControlExternalRelayDevice = { deviceSid: persistedSid };
    credentials.set(PASS_HASH_CREDENTIAL_KEY, persistedPassHash);

    const [windowA, windowB] = await Promise.all([
      startWindow(10, "C:/workspace/concurrent-a"),
      startWindow(11, "C:/workspace/concurrent-b"),
    ]);
    const sessionIds = [windowA.sessionId, windowB.sessionId];
    expect(sessionIds.filter((sessionId) => sessionId === persistedSid)).toHaveLength(1);
    expect(new Set(sessionIds).size).toBe(2);

    const freshSid = sessionIds.find((sessionId) => sessionId !== persistedSid);
    expect(freshSid).toBeTruthy();
    expect(pairs.get(freshSid!)?.passHash).not.toBe(persistedPassHash);
  });

  it("refreshes the QR credentials after a relay pair expires and registers again", async () => {
    const initial = await startWindow(20, "C:/workspace/re-registered");
    manager.syncWorkspaces(20, [workspace("re-registered")]);
    const originalPair = pairs.get(initial.sessionId!);
    expect(originalPair?.device).toBeDefined();
    pairs.delete(initial.sessionId!);
    originalPair!.device!.close(4001, "pair-expired");

    await waitFor(
      () => {
        const status = manager.getStatus(20);
        return status.sessionId !== initial.sessionId && status.status === "running";
      },
      "new relay registration ready",
      6_000,
    );
    const recovered = manager.getStatus(20);
    const qr = new URL(recovered.qrUrl!);
    expect(qr.searchParams.get("sid")).toBe(recovered.sessionId);
    expect(qr.searchParams.get("hash")).toBe(pairs.get(recovered.sessionId!)?.passHash);
    expect(qr.searchParams.get("mid")).toBe("manager-test-mid");
    expect(qr.searchParams.get("name")).toBe("manager-test-device");
    expect(qr.searchParams.get("app_version")).toBe("0.0.0-test");

    // 使用二维码自身的凭据鉴权，避免仅比较投影字段而漏掉无法实际扫码配对的问题。
    const mobile = await connectMobile(qr.searchParams.get("sid")!, qr.searchParams.get("hash")!);
    expect((await requestBootstrap(mobile, "bootstrap-after-registration")).result).toMatchObject({
      workspaces: [expect.objectContaining({ workspaceKey: "re-registered" })],
    });
  });

  it("does not revive a window stopped while its settings read is pending", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    beforeSettingsRead = async () => {
      entered.resolve();
      await release.promise;
    };
    startedWindowIds.push(30);
    const starting = manager.start(30, { workspacePath: "C:/workspace/stopped-before-start" });
    await entered.promise;
    await manager.stop(30);
    release.resolve();

    expect((await starting).status).toBe("idle");
    expect(manager.getStatus(30)).toEqual({ status: "idle" });
    expect(registrationCount).toBe(0);
    expect(settings.webRemoteControlLastEnabledContext).toBeUndefined();
  });

  it("does not emit a stale start after the window closes during relay handshake", async () => {
    const release = Promise.withResolvers<void>();
    beforeAuthAck = release.promise;
    startedWindowIds.push(31);
    const starting = manager.start(31, { workspacePath: "C:/workspace/closed-in-handshake" });
    await waitFor(
      () => pairs.size === 1 && [...pairs.values()][0]?.device,
      "device authenticating",
    );
    await manager.disposeWindow(31);
    release.resolve();

    expect((await starting).status).toBe("idle");
    expect(statuses.filter((item) => item.windowId === 31).at(-1)?.snapshot).toEqual({
      status: "idle",
    });
    expect(settings.webRemoteControlLastEnabledContext).toBeUndefined();
  });

  it("keeps the later start when an older settings read completes last", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let readCount = 0;
    beforeSettingsRead = async () => {
      if (++readCount !== 1) return;
      entered.resolve();
      await release.promise;
    };
    startedWindowIds.push(32);
    const oldStart = manager.start(32, { workspacePath: "C:/workspace/old-start" });
    await entered.promise;
    const current = await manager.start(32, { workspacePath: "C:/workspace/new-start" });
    manager.syncWorkspaces(32, [workspace("new-start")]);
    release.resolve();
    await oldStart;

    expect(manager.getStatus(32).sessionId).toBe(current.sessionId);
    expect(registrationCount).toBe(1);
    const mobile = await connectMobile(current.sessionId!);
    expect((await requestBootstrap(mobile, "bootstrap-latest-start")).result).toMatchObject({
      workspaces: [expect.objectContaining({ workspaceKey: "new-start" })],
    });
  });

  it("does not restart a stopped window when pairing reset finishes clearing credentials", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    beforeCredentialDelete = async () => {
      entered.resolve();
      await release.promise;
    };
    startedWindowIds.push(33);
    const resetting = manager.resetPairing(33, { workspacePath: "C:/workspace/reset-cancelled" });
    await entered.promise;
    await manager.stop(33);
    release.resolve();

    expect((await resetting).status).toBe("idle");
    expect(registrationCount).toBe(0);
    expect(settings.webRemoteControlLastEnabledContext).toBeUndefined();
  });

  it("does not stop the replacement runtime when an older startup persistence fails", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    beforeSettingsUpdate = async (patch) => {
      if (patch.webRemoteControlLastEnabledContext?.workspacePath !== "C:/workspace/old-persist")
        return;
      entered.resolve();
      await release.promise;
      throw new Error("controlled old startup persistence failure");
    };
    startedWindowIds.push(34);
    const oldStart = manager.start(34, { workspacePath: "C:/workspace/old-persist" });
    await entered.promise;
    const current = await manager.start(34, { workspacePath: "C:/workspace/current-persist" });
    release.resolve();
    await oldStart;

    expect(manager.getStatus(34).sessionId).toBe(current.sessionId);
    expect(manager.getStatus(34).status).toBe("running");
    expect(settings.webRemoteControlLastEnabledContext?.workspacePath).toBe(
      "C:/workspace/current-persist",
    );
  });

  it("discards an old settings read failure after a replacement start succeeds", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let readCount = 0;
    beforeSettingsRead = async () => {
      if (++readCount !== 1) return;
      entered.resolve();
      await release.promise;
      throw new Error("controlled old settings read failure");
    };
    startedWindowIds.push(35);
    const oldResult = manager.start(35, { workspacePath: "C:/workspace/old-read" }).then(
      (snapshot) => ({ snapshot, error: undefined }),
      (error: unknown) => ({ snapshot: undefined, error }),
    );
    await entered.promise;
    const current = await manager.start(35, { workspacePath: "C:/workspace/current-read" });
    release.resolve();
    const result = await oldResult;

    expect(result.error).toBeUndefined();
    expect(result.snapshot?.sessionId).toBe(current.sessionId);
    expect(manager.getStatus(35).sessionId).toBe(current.sessionId);
  });

  it("discards a stale pairing-clear failure after the window stops", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    beforeSettingsUpdate = async (patch) => {
      if (!Object.hasOwn(patch, "webRemoteControlExternalRelayDevice")) return;
      entered.resolve();
      await release.promise;
      throw new Error("controlled old pairing clear failure");
    };
    const oldResult = manager.resetPairing(36, { workspacePath: "C:/workspace/old-clear" }).then(
      (snapshot) => ({ snapshot, error: undefined }),
      (error: unknown) => ({ snapshot: undefined, error }),
    );
    await entered.promise;
    await manager.stop(36);
    release.resolve();
    const result = await oldResult;

    expect(result.error).toBeUndefined();
    expect(result.snapshot?.status).toBe("idle");
    expect(registrationCount).toBe(0);
  });

  async function startWindow(windowId: number, workspacePath: string) {
    const snapshot = await manager.start(windowId, { workspacePath });
    startedWindowIds.push(windowId);
    return snapshot;
  }

  async function connectMobile(
    deviceSid: string,
    qrPassHash?: string,
    wsUrl = `ws://127.0.0.1:${port}/ws`,
  ): Promise<MobileConnection> {
    const pair = pairs.get(deviceSid);
    const passHash = qrPassHash ?? pair?.passHash;
    if (!passHash) throw new Error(`Missing relay pairing ${deviceSid}`);
    const connection: MobileConnection = {
      socket: new WebSocket(wsUrl),
      frames: [],
    };
    mobileConnections.push(connection);
    connection.socket.on("message", (raw) => {
      connection.frames.push(JSON.parse(raw.toString()) as Record<string, unknown>);
    });
    await waitFor(() => connection.socket.readyState === WebSocket.OPEN, "mobile socket open");
    connection.socket.send(
      JSON.stringify({
        type: "auth_init",
        role: "mobile",
        device_sid: deviceSid,
        client_ts: Date.now(),
      }),
    );
    const challenge = await waitForFrame(connection, "auth_challenge");
    const proof = createHmac("sha256", passHash)
      .update(`${String(challenge.nonce)}|mobile|${deviceSid}`)
      .digest("base64url");
    connection.socket.send(
      JSON.stringify({
        type: "auth_response",
        device_sid: deviceSid,
        proof,
        client_ts: Date.now(),
      }),
    );
    await waitForFrame(connection, "auth_ack");
    return connection;
  }

  async function requestBootstrap(connection: MobileConnection, requestId: string) {
    connection.socket.send(
      JSON.stringify({
        type: "data",
        payload: { zcode_type: "bootstrap-request", requestId },
      }),
    );
    const frame = await waitFor(
      () =>
        connection.frames.find(
          (item) =>
            item.type === "data" &&
            (item.payload as Record<string, unknown> | undefined)?.zcode_type ===
              "bootstrap-response" &&
            (item.payload as Record<string, unknown> | undefined)?.requestId === requestId,
        ),
      `bootstrap response ${requestId}`,
    );
    return frame.payload as { result: unknown };
  }

  async function waitForFrame(connection: MobileConnection, type: string) {
    return waitFor(() => connection.frames.find((frame) => frame.type === type), `mobile ${type}`);
  }
});

function workspace(workspaceKey: string): WebRemoteControlWorkspaceRef {
  return {
    workspaceKey,
    workspacePath: `C:/workspace/${workspaceKey}`,
    kind: "local",
  };
}

function isPaired(pair: RelayPair): boolean {
  return pair.device?.readyState === WebSocket.OPEN && pair.mobile?.readyState === WebSocket.OPEN;
}

function isCurrentBinding(pair: RelayPair, role: "device" | "mobile", socket: WebSocket): boolean {
  return (role === "device" ? pair.device : pair.mobile) === socket;
}

async function waitFor<T>(
  predicate: () => T | undefined | false,
  label: string,
  timeoutMs = 2_500,
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = predicate();
    if (value) return value as T;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
