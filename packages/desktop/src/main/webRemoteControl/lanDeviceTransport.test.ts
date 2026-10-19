import { createHash, createHmac, randomBytes } from "node:crypto";
import { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WEB_REMOTE_CONTROL_RPC_LIMITS } from "@zcode/shared";
import { WebSocket } from "ws";
import {
  createLanDeviceTransport,
  type WebRemoteControlDeviceTransportEvents,
} from "./deviceTransport.js";
import { LanRemoteControlEndpoint } from "./lanEndpoint.js";
import type { WebRemoteControlLogger } from "./logger.js";

/**
 * LAN 传输回归：持久化 deviceSid 失效时必须自动转注册流程。
 *
 * 线上路径：配对表只在端点内存里，桌面重启 / 「停止后重开」/ 其他窗口占用同一 sid 都会让
 * 落盘的 sid 查不到。以前这里直接把运行时置成 error，快照不带 qrUrl，UI 一直停在
 * 「正在准备二维码」，用户只能手动点「刷新二维码」。现在与 relay 传输对 AUTH_FAILED
 * 的处理对齐：清档 → 重新注册 → 新 sid，首开即可用。
 *
 * 用例跑真实端点（真实端口 + 真实 WS 握手），证明恢复后的新二维码能直接配对。
 */

const logger: WebRemoteControlLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

interface Recorder {
  events: WebRemoteControlDeviceTransportEvents;
  states: string[];
  registered: Array<{ deviceSid: string; passHash: string }>;
  errors: Error[];
  invalidPersistedAuth: { calls: number };
}

function createRecorder(): Recorder {
  const recorder: Recorder = {
    states: [],
    registered: [],
    errors: [],
    invalidPersistedAuth: { calls: 0 },
    events: {
      onStateChange: (state) => {
        recorder.states.push(state);
      },
      onPayload: () => undefined,
      onRegisteredAuth: (auth) => {
        recorder.registered.push(auth);
      },
      onError: (error) => {
        recorder.errors.push(error);
      },
      onInvalidPersistedAuth: async () => {
        recorder.invalidPersistedAuth.calls += 1;
      },
    },
  };
  return recorder;
}

async function hasListeningHttpEndpoint(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(250),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

async function closeTestServersOnPorts(ports: ReadonlySet<number>): Promise<void> {
  const getHandles = (process as NodeJS.Process & { _getActiveHandles(): unknown[] })
    ._getActiveHandles;
  for (const handle of getHandles.call(process)) {
    if (!(handle instanceof Server) || !handle.listening) continue;
    const address = handle.address();
    if (!address || typeof address === "string" || !ports.has(address.port)) continue;
    handle.closeAllConnections();
    await new Promise<void>((resolve) => handle.close(() => resolve()));
  }
}

/** 手机侧完整握手：auth_init → auth_challenge → auth_response → auth_ack。 */
async function pairMobile(
  port: number,
  deviceSid: string,
  passHash: string,
): Promise<{ socket: WebSocket; frames: Array<Record<string, unknown>> }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", (error: Error) => reject(error));
  });
  const frames: Array<Record<string, unknown>> = [];
  socket.on("message", (raw) => {
    frames.push(JSON.parse(raw.toString()) as Record<string, unknown>);
  });
  const waitForFrame = async (type: string): Promise<Record<string, unknown>> => {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const frame = frames.find((item) => item.type === type);
      if (frame) return frame;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`mobile never received ${type}`);
  };
  socket.send(
    JSON.stringify({
      type: "auth_init",
      role: "mobile",
      device_sid: deviceSid,
      client_ts: Date.now(),
    }),
  );
  const challenge = await waitForFrame("auth_challenge");
  const proof = createHmac("sha256", passHash)
    .update(`${String(challenge.nonce)}|mobile|${deviceSid}`)
    .digest("base64url");
  socket.send(
    JSON.stringify({ type: "auth_response", device_sid: deviceSid, proof, client_ts: Date.now() }),
  );
  await waitForFrame("auth_ack");
  return { socket, frames };
}

describe("createLanDeviceTransport", () => {
  let endpoint: LanRemoteControlEndpoint;
  let port: number;

  beforeEach(async () => {
    endpoint = new LanRemoteControlEndpoint({
      logger,
      deviceMid: "test-mid",
      deviceName: "test-device",
      appVersion: "0.0.0-test",
      handleMobilePayload: () => undefined,
      maxPhysicalFrameBytes: WEB_REMOTE_CONTROL_RPC_LIMITS.maxPhysicalFrameBytes,
    });
    const info = await endpoint.start();
    port = info.port;
  });

  afterEach(async () => {
    await endpoint.stop();
  });

  function transportOptions(
    auth: Parameters<typeof createLanDeviceTransport>[0]["auth"],
    events: WebRemoteControlDeviceTransportEvents,
  ) {
    return {
      logger,
      deviceMid: "test-mid",
      deviceName: "test-device",
      appVersion: "0.0.0-test",
      events,
      handleMobilePayload: () => undefined,
      maxPhysicalFrameBytes: WEB_REMOTE_CONTROL_RPC_LIMITS.maxPhysicalFrameBytes,
      endpoint,
      auth,
    };
  }

  it("持久化 sid 失效时自动转注册流程：首开即可拿到可用二维码", async () => {
    const passHash = createHash("sha256").update(randomBytes(24)).digest("base64url");
    const first = createRecorder();
    const firstTransport = createLanDeviceTransport(
      transportOptions({ mode: "register", passHash }, first.events),
    );
    await firstTransport.start();
    const staleSid = first.registered[0]?.deviceSid;
    expect(staleSid).toBeTruthy();
    // 桌面重启 / 停止后重开：配对项随 releaseDevice 从端点内存消失。
    firstTransport.dispose();

    const second = createRecorder();
    const secondTransport = createLanDeviceTransport(
      transportOptions({ mode: "persisted", deviceSid: staleSid ?? "", passHash }, second.events),
    );
    await secondTransport.start();

    expect(second.invalidPersistedAuth.calls).toBe(1);
    expect(second.registered).toHaveLength(1);
    const freshSid = second.registered[0]?.deviceSid ?? "";
    expect(freshSid).not.toBe(staleSid);
    // 不落 error：运行时才会保持 starting/running，快照的 qrUrl 才会输出给 UI。
    expect(second.states).not.toContain("error");
    expect(second.errors).toHaveLength(0);
    expect(second.states).toContain("waiting_terminal");

    // 恢复后的新 sid 就是新二维码指向的会话：手机能直接完成配对。
    const mobile = await pairMobile(port, freshSid, passHash);
    mobile.socket.close();
    secondTransport.dispose();
  });

  it("持久化 sid 仍有效时续用：不重新注册，手机保持已配对", async () => {
    const passHash = createHash("sha256").update(randomBytes(24)).digest("base64url");
    const first = createRecorder();
    const firstTransport = createLanDeviceTransport(
      transportOptions({ mode: "register", passHash }, first.events),
    );
    await firstTransport.start();
    const deviceSid = first.registered[0]?.deviceSid ?? "";
    expect(deviceSid).toBeTruthy();
    // 手机先连上；桌面侧释放后配对项仍保留（手机在线时 releaseDevice 不删项）。
    const mobile = await pairMobile(port, deviceSid, passHash);
    firstTransport.dispose();

    const second = createRecorder();
    const secondTransport = createLanDeviceTransport(
      transportOptions({ mode: "persisted", deviceSid, passHash }, second.events),
    );
    await secondTransport.start();

    expect(second.invalidPersistedAuth.calls).toBe(0);
    expect(second.registered).toHaveLength(0);
    expect(second.errors).toHaveLength(0);
    expect(second.states).toContain("paired");

    mobile.socket.close();
    secondTransport.dispose();
  });

  it("同一 sid 已被其他窗口占用时：本窗口改注册新 sid，不影响对方配对", async () => {
    const passHash = createHash("sha256").update(randomBytes(24)).digest("base64url");
    const first = createRecorder();
    const firstTransport = createLanDeviceTransport(
      transportOptions({ mode: "register", passHash }, first.events),
    );
    await firstTransport.start();
    const occupiedSid = first.registered[0]?.deviceSid ?? "";
    expect(occupiedSid).toBeTruthy();

    const second = createRecorder();
    const secondTransport = createLanDeviceTransport(
      transportOptions({ mode: "persisted", deviceSid: occupiedSid, passHash }, second.events),
    );
    await secondTransport.start();

    expect(second.invalidPersistedAuth.calls).toBe(1);
    const freshSid = second.registered[0]?.deviceSid ?? "";
    expect(freshSid).not.toBe(occupiedSid);
    expect(second.states).not.toContain("error");

    // 原窗口的配对没被抢走：手机仍能用旧 sid 连上并完成握手。
    const mobile = await pairMobile(port, occupiedSid, passHash);
    mobile.socket.close();
    firstTransport.dispose();
    secondTransport.dispose();
  });
});

describe("LAN endpoint startup lifecycle", () => {
  it("并发窗口启动共用一次 bind，停止后没有遗留监听", async () => {
    const sharedEndpoint = new LanRemoteControlEndpoint({
      logger,
      deviceMid: "test-mid",
      deviceName: "test-device",
      appVersion: "0.0.0-test",
      handleMobilePayload: () => undefined,
      maxPhysicalFrameBytes: WEB_REMOTE_CONTROL_RPC_LIMITS.maxPhysicalFrameBytes,
    });
    // 单地址让每次意外 bind 都占据不同 loopback 端口，便于检查 stop 是否关闭所有真实 listener。
    (sharedEndpoint as unknown as { collectBindAddresses(): string[] }).collectBindAddresses =
      () => ["127.0.0.1"];
    const originalStart = sharedEndpoint.start.bind(sharedEndpoint);
    const startPromises: Array<ReturnType<typeof sharedEndpoint.start>> = [];
    sharedEndpoint.start = () => {
      const pending = originalStart();
      startPromises.push(pending);
      return pending;
    };
    const ports = new Set<number>();
    const first = createRecorder();
    const second = createRecorder();
    const makeTransport = (recorder: Recorder) =>
      createLanDeviceTransport({
        logger,
        deviceMid: "test-mid",
        deviceName: "test-device",
        appVersion: "0.0.0-test",
        events: recorder.events,
        handleMobilePayload: () => undefined,
        maxPhysicalFrameBytes: WEB_REMOTE_CONTROL_RPC_LIMITS.maxPhysicalFrameBytes,
        endpoint: sharedEndpoint,
        auth: {
          mode: "register",
          passHash: createHash("sha256").update(randomBytes(24)).digest("base64url"),
        },
      });
    const firstTransport = makeTransport(first);
    const secondTransport = makeTransport(second);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      await Promise.all([firstTransport.start(), secondTransport.start()]);
      const infos = await Promise.all(startPromises);
      for (const info of infos) ports.add(info.port);
      await sharedEndpoint.stop();
      const stillListening = await Promise.all([...ports].map(hasListeningHttpEndpoint));

      expect({ distinctPorts: ports.size, stillListening }).toEqual({
        distinctPorts: 1,
        stillListening: [false],
      });
      expect(first.registered).toHaveLength(1);
      expect(second.registered).toHaveLength(1);
    } finally {
      firstTransport.dispose();
      secondTransport.dispose();
      await sharedEndpoint.stop();
      await closeTestServersOnPorts(ports);
      vi.useRealTimers();
    }
  });

  it("transport 在 endpoint 启动完成前 dispose 后不留下 pairing", async () => {
    const endpoint = new LanRemoteControlEndpoint({
      logger,
      deviceMid: "test-mid",
      deviceName: "test-device",
      appVersion: "0.0.0-test",
      handleMobilePayload: () => undefined,
      maxPhysicalFrameBytes: WEB_REMOTE_CONTROL_RPC_LIMITS.maxPhysicalFrameBytes,
    });
    let releaseStart!: () => void;
    let signalBound!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const bound = new Promise<void>((resolve) => {
      signalBound = resolve;
    });
    const originalStart = endpoint.start.bind(endpoint);
    endpoint.start = async () => {
      const info = await originalStart();
      signalBound();
      await startGate;
      return info;
    };
    const recorder = createRecorder();
    const transport = createLanDeviceTransport({
      logger,
      deviceMid: "test-mid",
      deviceName: "test-device",
      appVersion: "0.0.0-test",
      events: recorder.events,
      handleMobilePayload: () => undefined,
      maxPhysicalFrameBytes: WEB_REMOTE_CONTROL_RPC_LIMITS.maxPhysicalFrameBytes,
      endpoint,
      auth: {
        mode: "register",
        passHash: createHash("sha256").update(randomBytes(24)).digest("base64url"),
      },
    });

    const starting = transport.start();
    try {
      await bound;
      transport.dispose();
      releaseStart();
      await starting;

      const health = await fetch(new URL("healthz", endpoint.baseUrls[0]));
      const status = (await health.json()) as { pairs: number };
      expect(status.pairs).toBe(0);
      expect(recorder.registered).toHaveLength(0);
    } finally {
      releaseStart();
      transport.dispose();
      await endpoint.stop();
    }
  });

  it("注册回调内同步 dispose 会释放刚创建的 handle", async () => {
    const endpoint = new LanRemoteControlEndpoint({
      logger,
      deviceMid: "test-mid",
      deviceName: "test-device",
      appVersion: "0.0.0-test",
      handleMobilePayload: () => undefined,
      maxPhysicalFrameBytes: WEB_REMOTE_CONTROL_RPC_LIMITS.maxPhysicalFrameBytes,
    });
    await endpoint.start();
    const recorder = createRecorder();
    let transport: ReturnType<typeof createLanDeviceTransport> | undefined;
    const events: WebRemoteControlDeviceTransportEvents = {
      ...recorder.events,
      onStateChange: (state) => {
        recorder.states.push(state);
        if (state === "registering") transport?.dispose();
      },
    };
    transport = createLanDeviceTransport({
      logger,
      deviceMid: "test-mid",
      deviceName: "test-device",
      appVersion: "0.0.0-test",
      events,
      handleMobilePayload: () => undefined,
      maxPhysicalFrameBytes: WEB_REMOTE_CONTROL_RPC_LIMITS.maxPhysicalFrameBytes,
      endpoint,
      auth: {
        mode: "register",
        passHash: createHash("sha256").update(randomBytes(24)).digest("base64url"),
      },
    });

    try {
      await transport.start();
      const health = await fetch(new URL("healthz", endpoint.baseUrls[0]));
      const status = (await health.json()) as { pairs: number };
      expect(status.pairs).toBe(0);
    } finally {
      transport.dispose();
      await endpoint.stop();
    }
  });
});
