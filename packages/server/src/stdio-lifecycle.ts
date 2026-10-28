import type { Readable } from "node:stream";

const TERMINATION_SIGNALS = ["SIGHUP", "SIGTERM", "SIGINT"] as const;
const DEFAULT_RPC_STOP_TIMEOUT_MS = 1_000;
const DEFAULT_SERVICE_DISPOSE_TIMEOUT_MS = 3_500;

type StdioShutdownPhase = "rpc-stop" | "service-dispose";

interface StdioProcessSignalSource {
  on(signal: (typeof TERMINATION_SIGNALS)[number], listener: () => void): unknown;
}

interface StdioProcessLifecycleOptions {
  stdin: Readable;
  signalSource: StdioProcessSignalSource;
  log: (...args: unknown[]) => void;
  stopRpc: () => Promise<void>;
  dispose: () => Promise<void>;
  exit: (code: number) => never | void;
  shutdownTimeoutMs?: number;
  rpcStopTimeoutMs?: number;
  serviceDisposeTimeoutMs?: number;
  waitForRuntimeCreation?: () => Promise<void> | undefined;
}

interface StdioRuntime {
  stopRpc: () => Promise<void>;
  dispose: () => Promise<void>;
  ready?: () => void;
}

interface StdioStartupTransport {
  stop: () => Promise<void>;
}

interface StartStdioProcessOptions<
  Prepared,
  Transport extends StdioStartupTransport | undefined = undefined,
> extends Omit<StdioProcessLifecycleOptions, "stopRpc" | "dispose" | "waitForRuntimeCreation"> {
  createTransport?: () => Transport;
  prepare: () => Promise<Prepared>;
  createRuntime: (prepared: Prepared, transport: Transport) => StdioRuntime;
  ready: () => void;
}

export async function startStdioProcess<
  Prepared,
  Transport extends StdioStartupTransport | undefined = undefined,
>(options: StartStdioProcessOptions<Prepared, Transport>): Promise<void> {
  let runtime: StdioRuntime | undefined;
  let transport: Transport | undefined;
  let runtimeCreation: Promise<void> | undefined;
  const createOwned = <T>(create: () => T): T => {
    let finishCreation!: () => void;
    runtimeCreation = new Promise<void>((resolve) => {
      finishCreation = resolve;
    });
    try {
      return create();
    } finally {
      runtimeCreation = undefined;
      finishCreation();
    }
  };
  // 配置 await 前注册唯一关闭 owner；关闭不等待配置 IO，迟到结果不再创建服务。
  const lifecycle = registerStdioProcessLifecycle({
    ...options,
    stopRpc: () => transport?.stop() ?? runtime?.stopRpc() ?? Promise.resolve(),
    dispose: () => runtime?.dispose() ?? Promise.resolve(),
    waitForRuntimeCreation: () => runtimeCreation,
  });
  if (lifecycle.shutdownStarted) return;
  try {
    if (options.createTransport) {
      transport = createOwned(options.createTransport);
      if (lifecycle.shutdownStarted) return;
      // 未消费的 ACK 后缀会挡住 EOF；先由同一协议 owner 读入缓存，但服务 ready 前不分派。
      options.stdin.resume();
    }
    const prepared = await options.prepare();
    if (lifecycle.shutdownStarted) return;
    runtime = createOwned(() => options.createRuntime(prepared, transport as Transport));
    if (lifecycle.shutdownStarted) return;
    options.stdin.resume();
    if (lifecycle.shutdownStarted) return;
    runtime.ready?.();
    if (!lifecycle.shutdownStarted) options.ready();
  } catch (error) {
    if (lifecycle.shutdownStarted) return;
    options.log("stdio startup failed", error);
    await lifecycle.shutdown(1);
  }
}

export function registerStdioProcessLifecycle(options: StdioProcessLifecycleOptions): {
  readonly shutdownStarted: boolean;
  shutdown: (exitCode: number) => Promise<void>;
} {
  const { stdin, signalSource, log, stopRpc, dispose, exit } = options;
  const rpcStopTimeoutMs = Math.max(
    options.rpcStopTimeoutMs ?? options.shutdownTimeoutMs ?? DEFAULT_RPC_STOP_TIMEOUT_MS,
    0,
  );
  const serviceDisposeTimeoutMs = Math.max(
    options.serviceDisposeTimeoutMs ??
      options.shutdownTimeoutMs ??
      DEFAULT_SERVICE_DISPOSE_TIMEOUT_MS,
    0,
  );
  let shutdownStarted = false;
  let requestedExitCode = 0;
  let shutdownPromise: Promise<void> | undefined;

  const requestShutdown = (exitCode: number): Promise<void> => {
    requestedExitCode = Math.max(requestedExitCode, exitCode);
    if (shutdownPromise) return shutdownPromise;
    shutdownStarted = true;
    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: unknown) => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    shutdownPromise = completion;

    void (async () => {
      // 同步 createRuntime 中发生关闭时，等当前调用归还资源再 stop；在线关闭仍同步开始 stopRpc。
      const runtimeCreation = options.waitForRuntimeCreation?.();
      if (runtimeCreation) await runtimeCreation;
      const runPhase = async (
        phase: StdioShutdownPhase,
        operation: () => Promise<void>,
        failureMessage: string,
        timeoutMs: number,
      ): Promise<boolean> => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let operationPromise: Promise<void>;
        try {
          // 返回 Promise 的 stop/dispose 仍可能同步抛错；同步调用保持 stop 时序，失败继续下一清理阶段。
          operationPromise = operation();
        } catch (error) {
          log(failureMessage, error);
          return false;
        }
        const operationResult = operationPromise.then(
          () => ({ kind: "completed" as const }),
          (error: unknown) => ({ kind: "failed" as const, error }),
        );
        const timedOut = new Promise<{ kind: "timed-out" }>((resolve) => {
          // timer 不能 unref，否则外部 Promise 永久 pending 时它无法独立保证收口。
          timeout = setTimeout(() => resolve({ kind: "timed-out" }), timeoutMs);
        });
        const result = await Promise.race([operationResult, timedOut]);
        if (timeout) {
          clearTimeout(timeout);
        }
        if (result.kind === "timed-out") {
          log("stdio shutdown timed out", { phase, timeoutMs });
          return false;
        }
        if (result.kind === "failed") {
          log(failureMessage, result.error);
          return false;
        }
        return true;
      };

      // 整个 cleanup 不能只设一个 race；stopRpc 一旦超时就直接 exit，
      // service dispose 永远没有机会关闭 Agent 子进程。两个外部异步边界必须各自有界并独立推进。
      if (
        !(await runPhase("rpc-stop", stopRpc, "stdio shutdown RPC stop failed", rpcStopTimeoutMs))
      ) {
        requestedExitCode = 1;
      }
      if (
        !(await runPhase(
          "service-dispose",
          dispose,
          "stdio shutdown cleanup failed",
          serviceDisposeTimeoutMs,
        ))
      ) {
        requestedExitCode = 1;
      }
      log("stdio shutdown completed", { exitCode: requestedExitCode });
      exit(requestedExitCode);
    })().then(resolveCompletion, rejectCompletion);
    return completion;
  };

  // 远程项目静置时可能长时间没有 client->server RPC 输入，但窗口仍然打开。
  // 不能再按空闲时间主动退出；只在 stdio 明确关闭或报错时结束远端 server，
  // 让远程连接生命周期跟随用户关闭项目/应用或底层 SSH 断连。
  const onStdinClosed = () => {
    log("stdin closed, shutting down");
    requestShutdown(stdin.errored ? 1 : 0);
  };
  stdin.on("end", onStdinClosed);
  stdin.on("close", onStdinClosed);
  stdin.on("error", (error) => {
    log("stdin error, shutting down", error);
    requestShutdown(1);
  });
  for (const signal of TERMINATION_SIGNALS) {
    signalSource.on(signal, () => {
      // SSH 断连在不同 sshd/shell 上可能表现为 stdin EOF，也可能先向前台进程发送信号。
      // 两类入口必须进入同一个幂等清理链路，否则 detached Agent 会绕过父进程退出而成为孤儿。
      log("termination signal received, shutting down", signal);
      requestShutdown(1);
    });
  }
  // end/error 不会为晚订阅自动补发；ACK 后的空档中已终结的 stdin 必须走同一个幂等门禁。
  if (stdin.errored) {
    log("stdin error, shutting down", stdin.errored);
    requestShutdown(1);
  } else if (stdin.readableEnded || stdin.destroyed) {
    onStdinClosed();
  }
  return {
    get shutdownStarted() {
      return shutdownStarted;
    },
    shutdown: requestShutdown,
  };
}
