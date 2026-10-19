import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBotRemoteWorkspaceService } from "../src/bots/botRemoteWorkspaceBridge.js";
import { createBotsService } from "../src/bots/botsService.js";
import { Event } from "@zcode/rpc";

const mocks = vi.hoisted(() => ({ createRuntime: vi.fn() }));
vi.mock("../src/bots/botRemoteRuntimeServices.js", () => ({
  createRemoteRuntimeServicesFromPort: mocks.createRuntime,
}));
const target = { workspacePath: "C:/synthetic/workspace", workspaceIdentity: "synthetic-remote" };
const closed = {
  name: "BotRemoteWorkspaceClosedError",
  code: "BOT_REMOTE_WORKSPACE_CLOSED",
  message: "远端 workspace 桥接已关闭。",
};
const kinds = [
  ["isConnected", "bot-remote-workspace-connection-status-result"],
  ["ensureConnected", "bot-remote-workspace-reconnect-result"],
  ["getZCodeTaskService", "bot-remote-workspace-runtime-port"],
  ["getModelSelectionService", "bot-remote-workspace-runtime-port"],
] as const;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
function fixture() {
  const port = Object.assign(new EventEmitter(), { postMessage: vi.fn() });
  const settings = {
    lastWorkspaceSession: [{ kind: "remote", ...target, target: { kind: "local" } }],
  };
  const get = vi.fn(async () => settings);
  const load = vi.fn(async () => "synthetic-secret");
  const runtime = {
    closed: false,
    onDidClose: Event.None,
    zcodeTaskService: {},
    modelSelectionService: { getView: vi.fn(async () => ({})) },
    zcodeAgentService: { syncAppRuntimePreferences: vi.fn(async () => {}) },
    dispose: vi.fn(),
  };
  mocks.createRuntime.mockReturnValue(runtime);
  const service = createBotRemoteWorkspaceService({
    parentPort: port,
    settingService: { get },
    credentialService: { load },
  } as unknown as Parameters<typeof createBotRemoteWorkspaceService>[0])!;
  const reply = (response: string, requestIndex = 0) =>
    port.emit("message", {
      data: {
        type: response,
        requestId: port.postMessage.mock.calls[requestIndex]![0].requestId,
        ok: true,
        connected: true,
        sessionId: "session",
      },
      ports: [{}],
    });
  return { service, port, settings, get, load, runtime, reply };
}
beforeEach(() => {
  vi.useFakeTimers();
  mocks.createRuntime.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Bot bridge closed contract", () => {
  it("settles mixed concurrent requests and leaves no timers", async () => {
    const f = fixture();
    const results = Array.from({ length: 64 }, (_, index) =>
      f.service[kinds[index % kinds.length]![0]](target).catch((error: unknown) => error),
    );
    await flush();
    expect(vi.getTimerCount()).toBe(64);
    f.service.dispose();
    expect(vi.getTimerCount()).toBe(0);
    for (const result of await Promise.all(results)) expect(result).toMatchObject(closed);
  });

  it("still waits for the latest preferences revision before caching runtime services", async () => {
    const f = fixture();
    const gate = deferred<void>();
    f.runtime.zcodeAgentService.syncAppRuntimePreferences.mockReturnValueOnce(gate.promise);
    let ready = false;
    const result = f.service.getZCodeTaskService(target).then((value) => {
      ready = true;
      return value;
    });
    await flush();
    f.reply(kinds[2][1]);
    await flush();
    expect(ready).toBe(false);
    await f.service.syncAppRuntimePreferences({ askUserQuestionAutoResolutionEnabled: false });
    gate.resolve();
    expect(await result).toBe(f.runtime.zcodeTaskService);
    expect(f.runtime.zcodeAgentService.syncAppRuntimePreferences.mock.calls).toEqual([
      [{ askUserQuestionAutoResolutionEnabled: true }],
      [{ askUserQuestionAutoResolutionEnabled: false }],
    ]);
    expect(await f.service.getZCodeTaskService(target)).toBe(f.runtime.zcodeTaskService);
    expect(f.port.postMessage).toHaveBeenCalledOnce();
    f.service.dispose();
  });

  it.each(["disposeAll", "disposeAllAndWait"] as const)(
    "reaches bridge close through BotsService %s",
    async (entry) => {
      const f = fixture();
      const bots = createBotsService({
        runStartupBackgroundTasks: false,
        remoteWorkspaceService: f.service,
        credentialService: { load: f.load },
      } as unknown as Parameters<typeof createBotsService>[0]);
      const result = f.service.ensureConnected(target).catch((error: unknown) => error);
      await flush();
      await bots[entry]();
      await bots.disposeAllAndWait();
      expect(await Promise.race([result, Promise.resolve("still pending")])).toMatchObject(closed);
      expect(f.port.listenerCount("message")).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("closes a received port before its async runtime continuation starts", async () => {
    const f = fixture();
    const close = vi.fn();
    const result = f.service.getZCodeTaskService(target).catch((error: unknown) => error);
    await flush();
    f.port.emit("message", {
      data: {
        type: kinds[2][1],
        requestId: f.port.postMessage.mock.calls[0]![0].requestId,
        ok: true,
      },
      ports: [{ close }],
    });
    f.service.dispose();
    await flush();
    expect(await result).toMatchObject(closed);
    expect(close).toHaveBeenCalledOnce();
    expect(mocks.createRuntime).not.toHaveBeenCalled();
  });
  it.each(kinds)("settles pending %s and ignores late responses", async (method, response) => {
    const f = fixture();
    const result = f.service[method](target).catch((error: unknown) => error);
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    f.service.dispose();
    f.service.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(f.port.listenerCount("message")).toBe(1);
    expect(await result).toMatchObject(closed);
    f.reply(response);
    await flush();
    expect(mocks.createRuntime).not.toHaveBeenCalled();
  });

  it("rejects all entries after close without IO, even with a ready cache", async () => {
    const f = fixture();
    const ready = f.service.getZCodeTaskService(target);
    await flush();
    f.reply(kinds[2][1]);
    await ready;
    f.service.dispose();
    const reads = f.get.mock.calls.length;
    const sends = f.port.postMessage.mock.calls.length;
    for (const [method] of kinds)
      await expect(f.service[method](target)).rejects.toMatchObject(closed);
    await expect(
      f.service.syncAppRuntimePreferences({ askUserQuestionAutoResolutionEnabled: false }),
    ).rejects.toMatchObject(closed);
    expect(f.get).toHaveBeenCalledTimes(reads);
    expect(f.port.postMessage).toHaveBeenCalledTimes(sends);
    expect(f.runtime.dispose).toHaveBeenCalledOnce();
  });

  it.each(kinds)(
    "rejects %s while settings are pending and prevents late sending",
    async (method) => {
      const f = fixture();
      const gate = deferred<typeof f.settings>();
      f.get.mockReturnValueOnce(gate.promise);
      const result = f.service[method](target).catch((error: unknown) => error);
      f.service.dispose();
      await flush();
      expect(await Promise.race([result, Promise.resolve("still pending")])).toMatchObject(closed);
      gate.resolve(f.settings);
      await flush();
      expect(f.port.postMessage).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("stops credential preparation before the second credential and consumes late rejection", async () => {
    const f = fixture();
    const gate = deferred<string>();
    f.settings.lastWorkspaceSession[0]!.target = {
      kind: "ssh",
      host: "synthetic.invalid",
      passwordCredentialKey: "password",
      privateKeyPassphraseCredentialKey: "passphrase",
    } as unknown as { kind: string };
    f.load.mockReturnValueOnce(gate.promise);
    const result = f.service.ensureConnected(target).catch((error: unknown) => error);
    await flush();
    expect(f.load).toHaveBeenCalledOnce();
    f.service.dispose();
    await flush();
    expect(await Promise.race([result, Promise.resolve("still pending")])).toMatchObject(closed);
    gate.reject(new Error("late credential failure"));
    await flush();
    expect(f.load).toHaveBeenCalledOnce();
    expect(f.port.postMessage).not.toHaveBeenCalled();
  });

  it.each(["view", "preferences"])(
    "closes a runtime during %s initialization and does not resume",
    async (phase) => {
      const f = fixture();
      const gate = deferred<never>();
      if (phase === "view")
        f.runtime.modelSelectionService.getView.mockReturnValueOnce(gate.promise);
      else f.runtime.zcodeAgentService.syncAppRuntimePreferences.mockReturnValueOnce(gate.promise);
      const result = f.service.getZCodeTaskService(target).catch((error: unknown) => error);
      await flush();
      f.reply(kinds[2][1]);
      await flush();
      f.service.dispose();
      await flush();
      expect(await Promise.race([result, Promise.resolve("still pending")])).toMatchObject(closed);
      expect(f.runtime.dispose).toHaveBeenCalledOnce();
      const syncs = f.runtime.zcodeAgentService.syncAppRuntimePreferences.mock.calls.length;
      gate.reject(new Error("late runtime failure"));
      await flush();
      expect(f.runtime.zcodeAgentService.syncAppRuntimePreferences).toHaveBeenCalledTimes(syncs);
      expect(f.runtime.dispose).toHaveBeenCalledOnce();
    },
  );

  it("closes existing preferences synchronization without waiting for the peer", async () => {
    const f = fixture();
    const ready = f.service.getZCodeTaskService(target);
    await flush();
    f.reply(kinds[2][1]);
    await ready;
    const gate = deferred<void>();
    f.runtime.zcodeAgentService.syncAppRuntimePreferences.mockReturnValueOnce(gate.promise);
    const result = f.service
      .syncAppRuntimePreferences({ askUserQuestionAutoResolutionEnabled: false })
      .catch((error: unknown) => error);
    f.service.dispose();
    await flush();
    expect(await Promise.race([result, Promise.resolve("still pending")])).toMatchObject(closed);
    gate.resolve();
    await flush();
    expect(f.runtime.dispose).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "handles reentrant close in postMessage, reply first=%s",
    async (replyFirst) => {
      const f = fixture();
      f.port.postMessage.mockImplementation(() => {
        if (replyFirst) f.reply(kinds[1][1]);
        f.service.dispose();
      });
      await expect(f.service.ensureConnected(target)).rejects.toMatchObject(closed);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("releases a runtime whose normal initialization fails", async () => {
    const f = fixture();
    const failure = new Error("view failed");
    f.runtime.modelSelectionService.getView.mockRejectedValueOnce(failure);
    const result = f.service.getZCodeTaskService(target).catch((error: unknown) => error);
    await flush();
    f.reply(kinds[2][1]);
    expect(await result).toBe(failure);
    expect(f.runtime.dispose).toHaveBeenCalledOnce();
    f.service.dispose();
    expect(f.runtime.dispose).toHaveBeenCalledOnce();
  });
});
