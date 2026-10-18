import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createRelayDeviceTransport } from "./relayTransport.js";
import type { WebRemoteControlLogger } from "./logger.js";

const logger: WebRemoteControlLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

interface RelayConnection {
  socket: WebSocket;
  frames: Array<Record<string, unknown>>;
}

describe("createRelayDeviceTransport reconnect lifecycle", () => {
  let httpServer: ReturnType<typeof createServer>;
  let relay: WebSocketServer;
  let port: number;
  let connections: RelayConnection[];
  let invalidPersistedSids: Set<string>;
  let transport: ReturnType<typeof createRelayDeviceTransport> | undefined;

  beforeEach(async () => {
    connections = [];
    invalidPersistedSids = new Set(["stale-sid"]);
    httpServer = createServer();
    relay = new WebSocketServer({ server: httpServer });
    relay.on("connection", (socket) => {
      const connection: RelayConnection = { socket, frames: [] };
      connections.push(connection);
      const connectionId = connections.length;

      if (connectionId === 1) {
        // 延迟 ACK 旧 socket 的 close，使立即启动的新注册连接先成为 current socket。
        const close = socket.close.bind(socket);
        socket.close = ((...args: Parameters<WebSocket["close"]>) => {
          setTimeout(() => close(...args), 100);
          return socket;
        }) as WebSocket["close"];
      }

      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
        connection.frames.push(frame);
        if (connectionId === 1 && frame.type === "auth_init") {
          socket.send(JSON.stringify({ type: "auth_challenge", nonce: "old-nonce" }));
        } else if (connectionId === 1 && frame.type === "auth_response") {
          socket.send(JSON.stringify({ type: "error", code: "AUTH_FAILED" }));
          socket.close(4001, "AUTH_FAILED");
        } else if (connectionId >= 2 && frame.type === "device_register_init") {
          socket.send(
            JSON.stringify({ type: "device_register_ack", device_sid: `new-sid-${connectionId}` }),
          );
        } else if (connectionId >= 2 && frame.type === "auth_init") {
          socket.send(JSON.stringify({ type: "auth_challenge", nonce: `nonce-${connectionId}` }));
        } else if (connectionId >= 2 && frame.type === "auth_response") {
          if (invalidPersistedSids.has(String(frame.device_sid ?? ""))) {
            socket.send(JSON.stringify({ type: "error", code: "AUTH_FAILED" }));
            socket.close(4001, "AUTH_FAILED");
          } else {
            socket.send(JSON.stringify({ type: "auth_ack", pair_status: "waiting" }));
          }
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    port = (httpServer.address() as { port: number }).port;
  });

  afterEach(async () => {
    transport?.dispose();
    transport = undefined;
    await new Promise<void>((resolve) => relay.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it("does not let a delayed stale close suppress reconnect of the replacement socket", async () => {
    const states: string[] = [];
    transport = createRelayDeviceTransport({
      logger,
      relayWsUrl: `ws://127.0.0.1:${port}/ws`,
      deviceMid: "review-mid",
      deviceName: "review-device",
      appVersion: "0.0.0-test",
      maxPhysicalFrameBytes: 1024 * 1024,
      auth: { mode: "persisted", deviceSid: "stale-sid", passHash: "pass-hash" },
      events: {
        onStateChange: (state) => states.push(state),
        onPayload: () => undefined,
        onRegisteredAuth: () => undefined,
        onError: () => undefined,
        onInvalidPersistedAuth: async () => undefined,
      },
    });

    await transport.start();
    await waitFor(() => connections.length >= 2, "replacement registration socket");
    await waitFor(
      () => connections[1]?.frames.some((frame) => frame.type === "auth_response"),
      "replacement authentication",
    );
    expect(states).toContain("waiting_terminal");
    expect(connections).toHaveLength(2);

    await waitFor(
      () => connections[0]?.socket.readyState === WebSocket.CLOSED,
      "delayed stale socket close",
    );
    // Allow the replacement client socket's close callback to observe its stale identity.
    await new Promise((resolve) => setTimeout(resolve, 20));
    connections[1]!.socket.close(1011, "network-drop");

    await waitFor(
      () => connections.length >= 3,
      "reconnect after replacement socket closes",
      2_500,
    );
    await waitFor(
      () =>
        connections[2]?.frames.some(
          (frame) => frame.type === "auth_init" && frame.device_sid === "new-sid-2",
        ),
      "replacement auth frame",
    ).catch(() => {
      throw new Error(
        `Timed out waiting for replacement auth frame: ${JSON.stringify({ states, frames: connections.map((connection) => connection.frames) })}`,
      );
    });
  });

  it("waits for persisted-auth cleanup before retrying a closed socket", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const states: string[] = [];
    const errors: Error[] = [];
    let signalCleanupStarted!: () => void;
    let releaseCleanup!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      signalCleanupStarted = resolve;
    });
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    transport = createRelayDeviceTransport({
      logger,
      relayWsUrl: `ws://127.0.0.1:${port}/ws`,
      deviceMid: "review-mid",
      deviceName: "review-device",
      appVersion: "0.0.0-test",
      maxPhysicalFrameBytes: 1024 * 1024,
      auth: { mode: "persisted", deviceSid: "stale-sid", passHash: "pass-hash" },
      events: {
        onStateChange: (state) => states.push(state),
        onPayload: () => undefined,
        onRegisteredAuth: () => undefined,
        onError: (error) => errors.push(error),
        onInvalidPersistedAuth: () => {
          signalCleanupStarted();
          return cleanupGate;
        },
      },
    });

    const startPromise = transport.start();
    let authSidsBeforeCleanupCompletes: string[] = [];
    let connectionCountBeforeCleanupCompletes = 0;
    let statesBeforeCleanupCompletes: string[] = [];
    try {
      await cleanupStarted;
      await waitFor(
        () => connections[0]?.socket.readyState === WebSocket.CLOSED,
        "relay close while persisted auth cleanup is pending",
      );
      await new Promise((resolve) => setTimeout(resolve, 1_150));
      authSidsBeforeCleanupCompletes = connections.flatMap((connection) =>
        connection.frames
          .filter((frame) => frame.type === "auth_init")
          .map((frame) => String(frame.device_sid)),
      );
      connectionCountBeforeCleanupCompletes = connections.length;
      statesBeforeCleanupCompletes = [...states];
    } finally {
      releaseCleanup();
    }

    await startPromise;
    expect(connectionCountBeforeCleanupCompletes).toBe(1);
    expect(authSidsBeforeCleanupCompletes).toEqual(["stale-sid"]);
    expect(statesBeforeCleanupCompletes).not.toContain("error");
    expect(errors).toEqual([]);
    expect(connections[1]?.frames).toContainEqual(
      expect.objectContaining({ type: "device_register_init" }),
    );
  });

  it("re-arms persisted-auth recovery after a successful auth acknowledgement", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const errors: Error[] = [];
    const registeredSids: string[] = [];
    let cleanupCount = 0;
    transport = createRelayDeviceTransport({
      logger,
      relayWsUrl: `ws://127.0.0.1:${port}/ws`,
      deviceMid: "review-mid",
      deviceName: "review-device",
      appVersion: "0.0.0-test",
      maxPhysicalFrameBytes: 1024 * 1024,
      auth: { mode: "persisted", deviceSid: "stale-sid", passHash: "pass-hash" },
      events: {
        onStateChange: () => undefined,
        onPayload: () => undefined,
        onRegisteredAuth: ({ deviceSid }) => registeredSids.push(deviceSid),
        onError: (error) => errors.push(error),
        onInvalidPersistedAuth: async () => {
          cleanupCount += 1;
        },
      },
    });

    await transport.start();
    expect(registeredSids).toEqual(["new-sid-2"]);
    invalidPersistedSids.add("new-sid-2");
    connections[1]!.socket.close(1012, "relay-restart");

    await waitFor(
      () => connections[2]?.frames.some((frame) => frame.type === "auth_response"),
      "reauthentication after relay restart",
    );
    await waitFor(() => cleanupCount > 1 || errors.length > 0, "second SID recovery result");
    expect(cleanupCount).toBe(2);
    await waitFor(
      () => connections[3]?.frames.some((frame) => frame.type === "device_register_init"),
      "registration after second persisted SID failure",
    );
    await waitFor(() => registeredSids.length === 2, "second registered SID");
    expect(registeredSids).toEqual(["new-sid-2", "new-sid-4"]);
    expect(errors).toEqual([]);
  });

  it("does not re-arm recovery until a newly registered SID is acknowledged", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    invalidPersistedSids.add("new-sid-2");
    let cleanupCount = 0;
    transport = createRelayDeviceTransport({
      logger,
      relayWsUrl: `ws://127.0.0.1:${port}/ws`,
      deviceMid: "review-mid",
      deviceName: "review-device",
      appVersion: "0.0.0-test",
      maxPhysicalFrameBytes: 1024 * 1024,
      auth: { mode: "persisted", deviceSid: "stale-sid", passHash: "pass-hash" },
      events: {
        onStateChange: () => undefined,
        onPayload: () => undefined,
        onRegisteredAuth: () => undefined,
        onError: () => undefined,
        onInvalidPersistedAuth: async () => {
          cleanupCount += 1;
        },
      },
    });

    const startPromise = transport.start();
    try {
      await waitFor(
        () => connections[2]?.frames.some((frame) => frame.type === "auth_response"),
        "bounded retry of an unacknowledged registered SID",
      );
      expect(cleanupCount).toBe(1);
      expect(
        connections.flatMap((connection) =>
          connection.frames.filter((frame) => frame.type === "device_register_init"),
        ),
      ).toHaveLength(1);
    } finally {
      transport.dispose();
    }
    await startPromise;
  });

  it("stops instead of reconnecting when persisted-auth cleanup fails", async () => {
    const failure = new Error("credential cleanup failed");
    const errors: Error[] = [];
    transport = createRelayDeviceTransport({
      logger,
      relayWsUrl: `ws://127.0.0.1:${port}/ws`,
      deviceMid: "review-mid",
      deviceName: "review-device",
      appVersion: "0.0.0-test",
      maxPhysicalFrameBytes: 1024 * 1024,
      auth: { mode: "persisted", deviceSid: "stale-sid", passHash: "pass-hash" },
      events: {
        onStateChange: () => undefined,
        onPayload: () => undefined,
        onRegisteredAuth: () => undefined,
        onError: (error) => errors.push(error),
        onInvalidPersistedAuth: async () => {
          throw failure;
        },
      },
    });

    await expect(transport.start()).rejects.toThrow("relay handshake failed");
    await waitFor(
      () => connections[0]?.socket.readyState === WebSocket.CLOSED,
      "socket close after failed cleanup",
    );
    expect(connections).toHaveLength(1);
    expect(errors).toEqual([failure]);
  });

  it("ignores persisted-auth cleanup completion after dispose", async () => {
    let signalCleanupStarted!: () => void;
    let signalCleanupCompleted!: () => void;
    let releaseCleanup!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      signalCleanupStarted = resolve;
    });
    const cleanupCompleted = new Promise<void>((resolve) => {
      signalCleanupCompleted = resolve;
    });
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    transport = createRelayDeviceTransport({
      logger,
      relayWsUrl: `ws://127.0.0.1:${port}/ws`,
      deviceMid: "review-mid",
      deviceName: "review-device",
      appVersion: "0.0.0-test",
      maxPhysicalFrameBytes: 1024 * 1024,
      auth: { mode: "persisted", deviceSid: "stale-sid", passHash: "pass-hash" },
      events: {
        onStateChange: () => undefined,
        onPayload: () => undefined,
        onRegisteredAuth: () => undefined,
        onError: () => undefined,
        onInvalidPersistedAuth: async () => {
          signalCleanupStarted();
          await cleanupGate;
          signalCleanupCompleted();
        },
      },
    });

    const startPromise = transport.start();
    await cleanupStarted;
    transport.dispose();
    releaseCleanup();
    await Promise.all([startPromise, cleanupCompleted]);

    expect(connections).toHaveLength(1);
    expect(connections[0]?.frames).not.toContainEqual(
      expect.objectContaining({ type: "device_register_init" }),
    );
  });
});

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
