import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DockerBackend } from "./docker-backend.js";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
  probeDockerDaemon: vi.fn(async () => {}),
  listDockerContainers: vi.fn(async () => [
    { name: "fixture-container", id: "fixture-container", state: "running" },
  ]),
  resolveDockerCommand: vi.fn(() => "docker"),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: mocks.spawn, execFile: mocks.execFile };
});

vi.mock("@zcode/server/remote/docker-detect.js", () => ({
  // Bug 原因：后端已改用抛错式 daemon 探测，旧 boolean mock 让生命周期用例在 spawn 前失败。
  // 修复依据：模拟当前公开接口，仍由同一探测 Promise 控制迟到 exec，不执行真实 Docker。
  probeDockerDaemon: mocks.probeDockerDaemon,
  listDockerContainers: mocks.listDockerContainers,
  resolveDockerCommand: mocks.resolveDockerCommand,
}));

type FakeChild = EventEmitter & {
  pid: number | undefined;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: (signal?: string) => boolean;
  killCalls: number;
};

const children: FakeChild[] = [];

function fakeChild(pid: number | undefined = 4242): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killCalls = 0;
  child.kill = ((_signal?: string) => {
    child.killCalls += 1;
    return true;
  }) as FakeChild["kill"];
  children.push(child);
  return child;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function backend(): DockerBackend {
  return new DockerBackend({ kind: "docker", container: "fixture-container" });
}

beforeEach(() => {
  children.length = 0;
  mocks.spawn.mockReset();
  mocks.spawn.mockImplementation((() => fakeChild()) as never);
  mocks.execFile.mockReset();
  mocks.execFile.mockImplementation(((...args: unknown[]) => {
    const callback = args.at(-1) as (error: unknown, stdout: string, stderr: string) => void;
    callback(null, "/root\n", "");
    return undefined;
  }) as never);
  mocks.probeDockerDaemon.mockReset();
  mocks.probeDockerDaemon.mockImplementation(async () => {});
  mocks.listDockerContainers.mockReset();
  mocks.listDockerContainers.mockImplementation(async () => [
    { name: "fixture-container", id: "fixture-container", state: "running" },
  ]);
  mocks.resolveDockerCommand.mockReset();
  mocks.resolveDockerCommand.mockImplementation(() => "docker");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DockerBackend exec 进程所有权", () => {
  it("exec 后命令自行退出：不 kill，disposeAndWait 直接收敛", async () => {
    const target = backend();
    const pending = target.exec("echo hi");
    await flush();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    const child = children[0]!;
    child.emit("spawn");
    const stream = await pending;
    expect(stream.stdin).toBe(child.stdin);
    child.emit("exit", 0);
    child.emit("close", 0);
    await target.disposeAndWait({ graceTimeoutMs: 50, killWaitTimeoutMs: 50 });
    expect(child.killCalls).toBe(0);
  });

  it("宽限期内退出不 kill，但 stdin 已结束", async () => {
    const target = backend();
    const pending = target.exec("sleep 1");
    await flush();
    const child = children[0]!;
    child.emit("spawn");
    const stream = await pending;
    expect(stream.stdin).toBe(child.stdin);
    const disposing = target.disposeAndWait({ graceTimeoutMs: 200, killWaitTimeoutMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    child.emit("exit", 0);
    child.emit("close", 0);
    await disposing;
    expect(child.killCalls).toBe(0);
    expect(child.stdin.writableEnded).toBe(true);
  });

  it("宽限未退则 kill：多个挂起 child 各只 kill 一次，且不发起新命令", async () => {
    const target = backend();
    const first = target.exec("server-a");
    await flush();
    children[0]!.emit("spawn");
    await first;
    const second = target.exec("server-b");
    await flush();
    children[1]!.emit("spawn");
    await second;
    const spawnedBefore = mocks.spawn.mock.calls.length;
    const firstDispose = target.disposeAndWait({ graceTimeoutMs: 20, killWaitTimeoutMs: 50 });
    const secondDispose = target.disposeAndWait();
    await Promise.all([firstDispose, secondDispose]);
    expect(children[0]!.killCalls).toBe(1);
    expect(children[1]!.killCalls).toBe(1);
    // 释放不得通过 docker stop/kill 等容器级命令实现，也不得再 spawn 任何进程。
    expect(mocks.spawn.mock.calls.length).toBe(spawnedBefore);
    expect(children[0]!.stdin.writableEnded).toBe(true);
    expect(children[1]!.stdin.writableEnded).toBe(true);
  });

  it("spawn 失败（无 pid）立即摘除，dispose 不再 kill", async () => {
    const target = backend();
    const pending = target.exec("ghost");
    await flush();
    const child = children[0]!;
    child.pid = undefined;
    child.emit("error", new Error("spawn failure"));
    await expect(pending).rejects.toThrow("spawn failure");
    await target.disposeAndWait({ graceTimeoutMs: 20, killWaitTimeoutMs: 20 });
    expect(child.killCalls).toBe(0);
  });

  it("alive error 保留所有权：dispose 仍结束 stdin 并 kill", async () => {
    const target = backend();
    const pending = target.exec("flaky");
    await flush();
    const child = children[0]!;
    child.emit("spawn");
    // spawn 已resolve 出 stdio 流；随后的 error 不再改变 exec 结果。
    const stream = await pending;
    expect(stream.stdin).toBe(child.stdin);
    // error 不等于进程已退出（IPC 失败时 pid 仍在）：所有权必须保留到 dispose 收口。
    child.emit("error", new Error("ipc failure"));
    await target.disposeAndWait({ graceTimeoutMs: 20, killWaitTimeoutMs: 30 });
    expect(child.stdin.writableEnded).toBe(true);
    expect(child.killCalls).toBe(1);
  });

  it("关闭期间迟到的 exec 不会 spawn", async () => {
    const target = backend();
    const gate = deferred<void>();
    mocks.probeDockerDaemon.mockImplementationOnce(() => gate.promise);
    const pending = target.exec("late");
    // 先同步挂上拒绝处理器再触发 dispose，避免拒绝在无处理器窗口内被 Node 记为未处理。
    const rejection = pending.catch((error: unknown) => error);
    target.dispose();
    gate.resolve();
    await flush();
    expect(mocks.spawn).not.toHaveBeenCalled();
    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/已释放/);
  });

  it("dispose 之后的新 exec 直接拒绝", async () => {
    const target = backend();
    target.dispose();
    const pending = target.exec("after");
    // 同步挂拒绝处理器：exec 入口即拒绝，不能留给无处理器窗口。
    const rejection = pending.catch((error: unknown) => error);
    await flush();
    expect(mocks.spawn).not.toHaveBeenCalled();
    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/已释放/);
  });

  it("重复 dispose/disposeAndWait 幂等：kill 仍是一次", async () => {
    const target = backend();
    const pending = target.exec("server");
    await flush();
    const child = children[0]!;
    child.emit("spawn");
    await pending;
    target.dispose();
    target.dispose();
    await target.disposeAndWait({ graceTimeoutMs: 20, killWaitTimeoutMs: 20 });
    await target.disposeAndWait();
    expect(child.killCalls).toBe(1);
  });

  it("stdio 与 onClose 行为保留", async () => {
    const target = backend();
    const pending = target.exec("echo hi");
    await flush();
    const child = children[0]!;
    child.emit("spawn");
    const stream = await pending;
    expect(stream.stdin).toBe(child.stdin);
    expect(stream.stdout).toBe(child.stdout);
    expect(stream.stderr).toBe(child.stderr);
    const codes: number[] = [];
    stream.onClose((code) => codes.push(code));
    child.emit("exit", 7);
    expect(codes).toEqual([7]);
    expect(child.killCalls).toBe(0);
  });

  it("upload 的 exec 产物同样登记并被 dispose 回收", async () => {
    const target = backend();
    // mkdir 走一次性 execFile；cat 管道走 exec()，必须与远端 server 一样被登记。
    void target
      .upload(fileURLToPath(import.meta.url), "~/.zcodium/server/probe.bin")
      .catch(() => undefined);
    // 上传链含真实 fs.stat，轮询到 spawn 而非固定 flush，避免时序脆弱。
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(1));
    const child = children[0]!;
    child.emit("spawn");
    await target.disposeAndWait({ graceTimeoutMs: 20, killWaitTimeoutMs: 20 });
    expect(child.killCalls).toBe(1);
  });

  it("graceTimeoutMs:0 立即进入 kill，不无限等待", async () => {
    const target = backend();
    const pending = target.exec("no-grace");
    await flush();
    const child = children[0]!;
    child.emit("spawn");
    await pending;
    // 旧实现 timeoutMs<=0 返回 closed.then：未终结 child 会无限等待，违反有界预算。
    await target.disposeAndWait({ graceTimeoutMs: 0, killWaitTimeoutMs: 0 });
    expect(child.killCalls).toBe(1);
  });

  it("killWaitTimeoutMs:0 即使 kill 后仍无终结也有限返回并保留所有权", async () => {
    const target = backend();
    const pending = target.exec("stubborn");
    await flush();
    const child = children[0]!;
    child.emit("spawn");
    await pending;
    await target.disposeAndWait({ graceTimeoutMs: 10, killWaitTimeoutMs: 0 });
    expect(child.killCalls).toBe(1);
    expect(child.stdin.writableEnded).toBe(true);
    // kill 后仍无终结：所有权保留（没有 exit/close 就不摘除登记），
    // 迟到 close 由 finish 的 Set.delete 幂等收口，不会重复 kill 或双结。
    child.emit("close", 0);
  });

  it("stdin.end() 同步回调重入 disposeAndWait 时返回同一 promise 且只 kill 一次", async () => {
    const target = backend();
    const pending = target.exec("reentrant");
    await flush();
    const child = children[0]!;
    child.emit("spawn");
    await pending;
    const originalEnd = child.stdin.end.bind(child.stdin);
    let inner: Promise<void> | undefined;
    let reentered = false;
    let ended = false;
    child.stdin.end = ((...args: unknown[]) => {
      if (!reentered) {
        reentered = true;
        // stdin.end() 由 disposeAndWait 的 endOwnedChildInput 同步调用；
        // 其同步回调重入 disposeAndWait 必须拿到同一个 in-flight promise。
        inner = target.disposeAndWait();
      }
      // 真实 end 只放行一次：重入调用内部的 endOwnedChildInput 也会走到这里。
      if (ended) return child.stdin;
      ended = true;
      return (originalEnd as (...a: unknown[]) => unknown)(...args);
    }) as typeof child.stdin.end;
    const outer = target.disposeAndWait({ graceTimeoutMs: 20, killWaitTimeoutMs: 20 });
    expect(inner).toBe(outer);
    await outer;
    expect(child.killCalls).toBe(1);
  });

  it("等待内部的未知异常向 disposeAndWait 调用方原样传播", async () => {
    const target = backend();
    const pending = target.exec("throwing-wait");
    await flush();
    const child = children[0]!;
    child.emit("spawn");
    await pending;
    // 正预算下 waitForOwnedExecChildClose 会走 setTimeout 分支；让首个 setTimeout
    // 同步抛错，模拟等待内部的未知异常。deferred completion 必须捕获 reject 并
    // 原样传播，不能吞改为 fulfill（旧 settle/settle 会 fulfill，本用例即红）。
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementationOnce(() => {
      throw new Error("fixture wait failure");
    });
    try {
      await expect(
        target.disposeAndWait({ graceTimeoutMs: 20, killWaitTimeoutMs: 20 }),
      ).rejects.toThrow("fixture wait failure");
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});
