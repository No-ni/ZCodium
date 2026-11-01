import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChannelClient,
  ChannelServer,
  ProxyChannel,
  type IMessagePassingProtocol,
  type VSBuffer,
} from "@zcode/rpc";
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

interface FakePty {
  kill: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  onData: (listener: (data: string) => void) => { dispose: () => void };
  onExit: (listener: (event: { exitCode: number }) => void) => { dispose: () => void };
  emitData: (data: string) => void;
  emitExit: (exitCode: number) => void;
}

function createFakePty(): FakePty {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: { exitCode: number }) => void>();
  return {
    kill: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    onData(listener) {
      dataListeners.add(listener);
      return { dispose: () => dataListeners.delete(listener) };
    },
    onExit(listener) {
      exitListeners.add(listener);
      return { dispose: () => exitListeners.delete(listener) };
    },
    emitData: (data) => dataListeners.forEach((listener) => listener(data)),
    emitExit: (exitCode) => exitListeners.forEach((listener) => listener({ exitCode })),
  };
}

/** 内存回环协议：把 server 侧消息处理器内的异常原样记录下来再重抛，用于观测"是否逃逸出协议边界"。 */
function createLoopback() {
  let serverMessage: ((message: VSBuffer) => void) | null = null;
  let clientMessage: ((message: VSBuffer) => void) | null = null;
  const escaped: unknown[] = [];
  const serverProtocol: IMessagePassingProtocol = {
    onMessage(listener) {
      serverMessage = (message) => {
        try {
          listener(message);
        } catch (error) {
          escaped.push(error);
          throw error;
        }
      };
      return { dispose() {} };
    },
    send(message) {
      clientMessage?.(message);
    },
  };
  const clientProtocol: IMessagePassingProtocol = {
    onMessage(listener) {
      clientMessage = listener;
      return { dispose() {} };
    },
    send(message) {
      serverMessage?.(message);
    },
  };
  return { serverProtocol, clientProtocol, escaped };
}

describe("terminal dynamic event lifecycle", () => {
  type Service = ReturnType<
    typeof import("../src/terminal/terminalService.js").createTerminalService
  > & { disposeAll(): void };
  let service: Service;
  let getSettings: ReturnType<typeof vi.fn>;
  let spawn: ReturnType<typeof vi.fn>;
  let ptys: FakePty[];

  beforeEach(async () => {
    vi.resetModules();
    profile.mockClear();
    ptys = [];
    spawn = vi.fn(() => {
      const pty = createFakePty();
      ptys.push(pty);
      return pty;
    });
    vi.doMock("node-pty", () => ({ spawn }));
    getSettings = vi.fn(async () => ({ terminalInheritSystemProfile: false }));
    const { createTerminalService } = await import("../src/terminal/terminalService.js");
    service = createTerminalService({
      settingService: { get: getSettings } as unknown as ISettingService,
    }) as Service;
  });

  afterEach(() => {
    service.disposeAll();
    vi.doUnmock("node-pty");
  });

  const params = { cols: 80, rows: 24, cwd: "C:/synthetic/workspace" };

  it("活跃终端的 onData / onExit 继续投递，且不与同实例其他终端串扰", async () => {
    const first = await service.create(params);
    const second = await service.create(params);
    const firstData = vi.fn();
    const firstExit = vi.fn();
    const secondData = vi.fn();
    service.onDynamicData(first.id)(firstData);
    service.onDynamicExit(first.id)(firstExit);
    service.onDynamicData(second.id)(secondData);

    ptys[0].emitData("first-output");
    ptys[1].emitData("second-output");
    expect(firstData).toHaveBeenCalledExactlyOnceWith("first-output");
    expect(secondData).toHaveBeenCalledExactlyOnceWith("second-output");
    ptys[0].emitExit(3);
    expect(firstExit).toHaveBeenCalledExactlyOnceWith(3);
  });

  it("未知 id 的两个动态事件都不抛出，订阅后不触发回调", () => {
    const data = vi.fn();
    const exit = vi.fn();
    expect(() => service.onDynamicData("missing-terminal")(data)).not.toThrow();
    expect(() => service.onDynamicExit("missing-terminal")(exit)).not.toThrow();
    expect(data).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("PTY 自然退出后订阅两个动态事件都不抛出", async () => {
    const terminal = await service.create(params);
    ptys[0].emitExit(0);
    const data = vi.fn();
    const exit = vi.fn();
    expect(() => service.onDynamicData(terminal.id)(data)).not.toThrow();
    expect(() => service.onDynamicExit(terminal.id)(exit)).not.toThrow();
    ptys[0].emitData("late-output");
    ptys[0].emitExit(9);
    expect(data).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("dispose 后订阅两个动态事件都不抛出", async () => {
    const terminal = await service.create(params);
    await service.dispose({ id: terminal.id });
    const data = vi.fn();
    const exit = vi.fn();
    expect(() => service.onDynamicData(terminal.id)(data)).not.toThrow();
    expect(() => service.onDynamicExit(terminal.id)(exit)).not.toThrow();
    expect(data).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("disposeAll 后订阅两个动态事件都不抛出", async () => {
    const terminal = await service.create(params);
    service.disposeAll();
    const data = vi.fn();
    const exit = vi.fn();
    expect(() => service.onDynamicData(terminal.id)(data)).not.toThrow();
    expect(() => service.onDynamicExit(terminal.id)(exit)).not.toThrow();
    expect(data).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("退出终端的 stale 订阅不会误接到其他活跃终端", async () => {
    const stale = await service.create(params);
    const active = await service.create(params);
    const staleData = vi.fn();
    const staleExit = vi.fn();
    const activeData = vi.fn();
    const activeExit = vi.fn();
    service.onDynamicData(active.id)(activeData);
    service.onDynamicExit(active.id)(activeExit);
    ptys[0].emitExit(0);

    expect(() => service.onDynamicData(stale.id)(staleData)).not.toThrow();
    expect(() => service.onDynamicExit(stale.id)(staleExit)).not.toThrow();

    ptys[1].emitData("active-output");
    ptys[1].emitExit(5);
    expect(activeData).toHaveBeenCalledExactlyOnceWith("active-output");
    expect(activeExit).toHaveBeenCalledExactlyOnceWith(5);
    expect(staleData).not.toHaveBeenCalled();
    expect(staleExit).not.toHaveBeenCalled();
  });

  it("write / resize 对未知 id 仍抛 Terminal not found，退出后 write 仍抛", async () => {
    await expect(service.write({ id: "missing-terminal", data: "x" })).rejects.toThrow(
      "Terminal not found",
    );
    await expect(service.resize({ id: "missing-terminal", cols: 10, rows: 5 })).rejects.toThrow(
      "Terminal not found",
    );
    const terminal = await service.create(params);
    ptys[0].emitExit(0);
    await expect(service.write({ id: terminal.id, data: "late" })).rejects.toThrow(
      "Terminal not found",
    );
  });

  it("经真实 RPC 回环订阅已退出终端不逃逸协议消息处理器", async () => {
    const terminal = await service.create(params);
    ptys[0].emitExit(0);
    const { serverProtocol, clientProtocol, escaped } = createLoopback();
    // 先建 client 再接 server：server 构造即发 Initialize，client 必须先接线才能完成握手。
    const client = new ChannelClient(clientProtocol);
    const server = new ChannelServer(serverProtocol, "ctx");
    server.registerChannel("Terminal", ProxyChannel.fromService(service));
    const channel = client.getChannel("Terminal");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    const received: string[] = [];
    const subscription = channel.listen(
      "onDynamicData",
      terminal.id,
    )((data: string) => received.push(data));
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    ptys[0].emitData("after-exit");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(escaped).toEqual([]);
    expect(received).toEqual([]);
    subscription.dispose();
    client.dispose();
    server.dispose();
  });
});
