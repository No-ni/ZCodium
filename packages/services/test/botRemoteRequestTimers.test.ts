import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBotRemoteWorkspaceService } from "../src/bots/botRemoteWorkspaceBridge.js";

const runtime = vi.hoisted(() => ({
  closed: false,
  onDidClose: () => ({ dispose() {} }),
  dispose: vi.fn(),
  zcodeTaskService: {},
  modelSelectionService: { getView: vi.fn(async () => ({})) },
  zcodeAgentService: { syncAppRuntimePreferences: vi.fn(async () => {}) },
}));
vi.mock("../src/bots/botRemoteRuntimeServices.js", () => ({
  createRemoteRuntimeServicesFromPort: () => runtime,
}));
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const target = { workspacePath: "C:/synthetic/alias", workspaceIdentity: "remote-identity" };
const kinds = [
  {
    method: "isConnected",
    response: "bot-remote-workspace-connection-status-result",
    timeout: 5000,
  },
  { method: "ensureConnected", response: "bot-remote-workspace-reconnect-result", timeout: 60_000 },
  { method: "getZCodeTaskService", response: "bot-remote-workspace-runtime-port", timeout: 60_000 },
] as const;
type Kind = (typeof kinds)[number];
type Message = {
  type: string;
  requestId: string;
  workspaceIdentity: string;
  workspacePath: string;
};

function fixture() {
  const port = Object.assign(new EventEmitter(), {
    postMessage: vi.fn<(message: Message) => void>(),
  });
  const service = createBotRemoteWorkspaceService({
    parentPort: port,
    settingService: {
      get: async () => ({
        lastWorkspaceSession: [
          {
            kind: "remote",
            ...target,
            workspacePath: "C:/synthetic/realpath",
            target: { kind: "local" },
          },
        ],
      }),
    },
    credentialService: { load: vi.fn() },
  } as unknown as Parameters<typeof createBotRemoteWorkspaceService>[0])!;
  const reply = (kind: Kind, message: Message, ok = true) =>
    port.emit("message", {
      data: {
        type: kind.response,
        requestId: message.requestId,
        ok,
        connected: true,
        sessionId: "session",
        ...(ok ? {} : { error: "synthetic-error" }),
      },
      ports: ok ? [{}] : [],
    });
  return { port, service, reply };
}
async function microtasks() {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

describe.each(kinds)("Bot $method request lifetime", (kind) => {
  it.each([true, false])("clears completed deadline for ok=%s and preserves result", async (ok) => {
    const f = fixture();
    const result = f.service[kind.method](target).then(
      (value) => value,
      (error: Error) => error.message,
    );
    await microtasks();
    expect(vi.getTimerCount()).toBe(1);
    const message = f.port.postMessage.mock.calls[0]![0];
    expect(message).toMatchObject(target);
    f.reply(kind, message, ok);
    const value = await result;
    if (kind.method === "isConnected") expect(value).toBe(ok);
    if (kind.method === "ensureConnected")
      expect(value).toEqual(ok ? { ok: true } : { ok: false, message: "synthetic-error" });
    if (kind.method === "getZCodeTaskService")
      expect(value).toEqual(ok ? runtime.zcodeTaskService : "synthetic-error");
    expect(vi.getTimerCount()).toBe(0);
    f.service.dispose();
  });

  it("does not create a timer after synchronous response", async () => {
    const f = fixture();
    f.port.postMessage.mockImplementation((message) => {
      f.reply(kind, message);
    });
    await f.service[kind.method](target);
    expect(vi.getTimerCount()).toBe(0);
    f.service.dispose();
  });

  it("keeps requests independent and ignores malformed, wrong-id and late replies", async () => {
    const f = fixture();
    const requests = Array.from({ length: 64 }, () => f.service[kind.method](target));
    await microtasks();
    expect(vi.getTimerCount()).toBe(64);
    const messages = f.port.postMessage.mock.calls.map(([message]) => message);
    f.port.emit("message", {
      data: { type: kind.response, requestId: messages[0]!.requestId, ok: "invalid" },
    });
    f.reply(kind, { ...messages[0]!, requestId: "wrong" });
    expect(vi.getTimerCount()).toBe(64);
    for (const message of messages) f.reply(kind, message);
    await Promise.all(requests);
    expect(vi.getTimerCount()).toBe(0);
    for (const message of messages) f.reply(kind, message, false);
    expect(vi.getTimerCount()).toBe(0);
    f.service.dispose();
  });

  it("preserves exact deadline and timeout result", async () => {
    const f = fixture();
    let settled = false;
    const request = f.service[kind.method](target).then(
      (value) => {
        settled = true;
        return value;
      },
      (error: Error) => {
        settled = true;
        return error.message;
      },
    );
    await microtasks();
    await vi.advanceTimersByTimeAsync(kind.timeout - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const value = await request;
    if (kind.method === "isConnected") expect(value).toBe(false);
    if (kind.method === "ensureConnected")
      expect(value).toEqual({ ok: false, message: "远端 workspace 重连超时。" });
    if (kind.method === "getZCodeTaskService")
      expect(value).toBe("远端 workspace runtime 初始化超时。");
    f.reply(kind, f.port.postMessage.mock.calls[0]![0]);
    expect(vi.getTimerCount()).toBe(0);
    f.service.dispose();
  });

  it("preserves send errors without scheduling work", async () => {
    const f = fixture();
    const error = new Error("synthetic send failure");
    f.port.postMessage.mockImplementation(() => {
      throw error;
    });
    await expect(f.service[kind.method](target)).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
    f.service.dispose();
  });
});
