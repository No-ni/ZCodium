import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ISettingService } from "../src/setting/setting.js";

// 全部系统探测均使用合成输入；不能读取用户 profile 或启动真实 shell。
vi.mock("node:fs", () => ({
  accessSync: vi.fn(),
  statSync: () => ({ isDirectory: () => true }),
  existsSync: () => false,
  chmodSync: () => {
    throw new Error("Unexpected chmod");
  },
  constants: { X_OK: 1 },
}));
vi.mock("node:os", () => ({ homedir: () => "C:/synthetic/home", release: () => "10.0.22631" }));
const profile = vi.hoisted(() => vi.fn(() => ({ fontFamily: "monospace", source: "fallback" })));
vi.mock("../src/terminal/terminalProfile.js", () => ({ resolveTerminalFontProfile: profile }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createFakePty() {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: { exitCode: number }) => void>();
  return {
    kill: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    onData(listener: (data: string) => void) {
      dataListeners.add(listener);
      return { dispose: () => dataListeners.delete(listener) };
    },
    onExit(listener: (event: { exitCode: number }) => void) {
      exitListeners.add(listener);
      return { dispose: () => exitListeners.delete(listener) };
    },
    emitData: (data: string) => dataListeners.forEach((listener) => listener(data)),
    emitExit: (exitCode: number) => exitListeners.forEach((listener) => listener({ exitCode })),
  };
}

describe("terminal service shutdown admission", () => {
  let service: ReturnType<
    typeof import("../src/terminal/terminalService.js").createTerminalService
  > & { disposeAll(): void };
  let getSettings: ReturnType<typeof vi.fn>;
  let spawn: ReturnType<typeof vi.fn>;
  let moduleGate: ReturnType<typeof deferred<void>>;
  let moduleRequested: ReturnType<typeof deferred<void>>;
  let ptys: ReturnType<typeof createFakePty>[];

  beforeEach(async () => {
    vi.resetModules();
    profile.mockClear();
    moduleGate = deferred<void>();
    moduleRequested = deferred<void>();
    ptys = [];
    spawn = vi.fn(() => {
      const pty = createFakePty();
      ptys.push(pty);
      return pty;
    });
    vi.doMock("node-pty", async () => {
      moduleRequested.resolve();
      await moduleGate.promise;
      return { spawn };
    });
    getSettings = vi.fn(async () => ({ terminalInheritSystemProfile: false }));
    const { createTerminalService } = await import("../src/terminal/terminalService.js");
    service = createTerminalService({
      settingService: { get: getSettings } as unknown as ISettingService,
    }) as typeof service;
  });

  afterEach(() => {
    moduleGate.resolve();
    service.disposeAll();
    vi.doUnmock("node-pty");
  });

  const params = { cols: 80, rows: 24, cwd: "C:/synthetic/workspace" };

  it("does not inspect profiles or spawn after shutdown during settings read", async () => {
    const settings = deferred<{ terminalInheritSystemProfile: boolean }>();
    getSettings.mockReturnValueOnce(settings.promise);
    moduleGate.resolve();
    const outcome = service.create(params).catch((error: unknown) => error);
    service.disposeAll();
    settings.resolve({ terminalInheritSystemProfile: false });
    expect(await outcome).toEqual(new Error("Terminal service is disposed"));
    expect(profile).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not spawn after shutdown during node-pty loading", async () => {
    const outcome = service.create(params).catch((error: unknown) => error);
    await moduleRequested.promise;
    service.disposeAll();
    moduleGate.resolve();
    expect(await outcome).toEqual(new Error("Terminal service is disposed"));
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects new requests after shutdown before reading settings", async () => {
    moduleGate.resolve();
    service.disposeAll();
    await expect(service.create(params)).rejects.toThrow("Terminal service is disposed");
    expect(getSettings).not.toHaveBeenCalled();
    expect(profile).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("preserves active data, writes, resizing and natural exit", async () => {
    moduleGate.resolve();
    const terminal = await service.create(params);
    const data = vi.fn();
    const exit = vi.fn();
    service.onDynamicData(terminal.id)(data);
    service.onDynamicExit(terminal.id)(exit);
    ptys[0].emitData("synthetic output");
    await service.write({ id: terminal.id, data: "input" });
    await service.resize({ id: terminal.id, cols: 100, rows: 30 });
    expect(data).toHaveBeenCalledWith("synthetic output");
    expect(ptys[0].write).toHaveBeenCalledWith("input");
    expect(ptys[0].resize).toHaveBeenCalledWith(100, 30);
    ptys[0].emitExit(7);
    expect(exit).toHaveBeenCalledExactlyOnceWith(7);
    await expect(service.write({ id: terminal.id, data: "late" })).rejects.toThrow(
      "Terminal not found",
    );
    service.disposeAll();
    expect(ptys[0].kill).not.toHaveBeenCalled();
  });

  it("does not cancel another service using the shared pending module", async () => {
    const { createTerminalService } = await import("../src/terminal/terminalService.js");
    const other = createTerminalService({
      settingService: { get: getSettings } as unknown as ISettingService,
    }) as typeof service;
    try {
      const stopped = service.create(params).catch((error: unknown) => error);
      await moduleRequested.promise;
      const active = other.create(params);
      service.disposeAll();
      moduleGate.resolve();
      expect(await stopped).toEqual(new Error("Terminal service is disposed"));
      expect((await active).fontFamily).toBe("monospace");
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(ptys[0].kill).not.toHaveBeenCalled();
    } finally {
      other.disposeAll();
    }
    expect(ptys[0].kill).toHaveBeenCalledTimes(1);
  });

  it("kills each open terminal once and keeps the settings failure fallback", async () => {
    moduleGate.resolve();
    getSettings.mockRejectedValueOnce(new Error("synthetic settings failure"));
    const first = await service.create(params);
    const second = await service.create(params);
    expect(first.fontFamily).toBe("monospace");
    expect(second.id).not.toBe(first.id);
    service.disposeAll();
    service.disposeAll();
    expect(spawn).toHaveBeenCalledTimes(2);
    for (const pty of ptys) expect(pty.kill).toHaveBeenCalledTimes(1);
  });
});
