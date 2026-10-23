import { safeLogArgs } from "@zcode/shared";
import { createRemoteDiagnosticConsumer } from "./diagnosticStream.js";
import { SocketProtocol, ChannelClient, type IDisposable, type ISocket } from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import { RemoteServiceAccess } from "@zcode/client";
import {
  SERVICE_AUTHORITY_MODE_ENV,
  ZCODE_APP_VERSION_ENV,
  ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV,
  ZCODE_DYNAMIC_WORKFLOW_MODE_ENV,
  formatLogPrefix,
  ZCODE_REMOTE_HTTP_PROXY_ENV_KEY,
  ZCODE_REMOTE_NO_PROXY_ENV_KEY,
  ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY,
} from "@zcode/shared";
import type { IRemoteBackend } from "./backend.js";
import { wrapStdioStream } from "./stdio-socket.js";
import { performHandshake } from "./handshake.js";
import { deployServer } from "./deploy.js";
import type { DeployOptions } from "./deploy.js";
import { assertSupportedRemoteEnvironment } from "@zcode/server/remote/remotePlatformSupport.js";
import { quotePosixShellArg } from "./posixShell.js";
import { formatWslProxyForLog } from "./wslProxy.js";

const BACKEND_DISCONNECT_EXIT_CODE = -1;

export interface ConnectOptions extends DeployOptions {
  /** Client identifier for handshake */
  clientId?: string;
  /** Handshake timeout in ms (default: 10000) */
  handshakeTimeout?: number;
  /** Skip deploy step (assume server is already deployed) */
  skipDeploy?: boolean;
  /** 桌面 app 版本；用于透传给远端 agent，让模型请求 header 能标识发起方版本 */
  appVersion?: string;
  /** 远端 server/agent 需要继承的非敏感产品环境变量；调用方可传较宽的 env，server 侧会按白名单过滤。 */
  remoteRuntimeEnv?: Record<string, string | undefined>;
  /** Desktop Host 为 desktop-attached WSL server 提供的显式 Agent 网络配置。 */
  remoteRuntimeNetwork?: RemoteRuntimeNetworkOptions;
  /** 远端 stdio 关闭后的回调（用于上层感知断连并触发回收） */
  onDidRemoteClose?: (event: { code: number }) => void;
}

export interface RemoteRuntimeNetworkOptions {
  httpProxy?: string;
  noProxy?: string;
  /** 只允许 Host 设置权威值覆盖远端自身的旧设置。 */
  authoritative?: boolean;
}

export interface RemoteConnection {
  services: IServiceAccessor;
  client: ChannelClient;
  dispose(): void;
  disposeAndWait(options?: { timeoutMs?: number }): Promise<void>;
}

const REMOTE_RUNTIME_ENV_KEYS = [
  "ZCODE_ENV",
  "ZCODE_BASE_URL",
  "ZCODE_ENDPOINT_ORIGIN",
  "ZAI_OAUTH_ORIGIN",
  "ZAI_BUSINESS_BASE_URL",
  "ZAI_OAUTH_CLIENT_ID",
  // 由 Desktop Main 计算并下发；远端 server 只消费，不重新计算。
  ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV,
  // 同上：本地覆盖由 Desktop Main 按构建档位写定（buildHostProcessEnv），
  // 透传后 SSH/WSL/Docker 远端 Host 与本地 Host 得到同一档位。
  ZCODE_DYNAMIC_WORKFLOW_MODE_ENV,
] as const;

export type RemoteRuntimeEnvKey = (typeof REMOTE_RUNTIME_ENV_KEYS)[number];
export type RemoteRuntimeEnv = Partial<Record<RemoteRuntimeEnvKey, string>>;

export function pickRemoteRuntimeEnv(env: Record<string, string | undefined>): RemoteRuntimeEnv {
  const picked: RemoteRuntimeEnv = {};
  for (const key of REMOTE_RUNTIME_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) {
      picked[key] = value;
    }
  }
  return picked;
}

function createRemoteConnectAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error("Remote connection canceled");
  error.name = "AbortError";
  return error;
}

function throwIfRemoteConnectAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createRemoteConnectAbortError(signal);
  }
}

interface RemoteBackendOwner {
  dispose(): void;
  disposeAndWait(): Promise<void>;
  readonly disposed: boolean;
}

/**
 * Connect to a remote zcode server via an IRemoteBackend.
 *
 * Steps:
 * 1. detect() → { platform, arch }
 * 2. Deploy if needed (upload node + server bundle + node-pty)
 * 3. exec server command
 * 4. Handshake (read hello, pause at its boundary, send ack)
 * 5. Bind lifecycle and stdio → ISocket → SocketProtocol → ChannelClient, then resume
 */
export async function connectRemote(
  backend: IRemoteBackend,
  options?: ConnectOptions,
): Promise<RemoteConnection> {
  const signal = options?.signal;
  let backendDisposed = false;
  const backendOwner: RemoteBackendOwner = {
    get disposed() {
      return backendDisposed;
    },
    dispose() {
      if (backendDisposed) return;
      backendDisposed = true;
      backend.dispose();
    },
    async disposeAndWait() {
      if (backendDisposed) return;
      backendDisposed = true;
      if (backend.disposeAndWait) await backend.disposeAndWait();
      else backend.dispose();
    },
  };
  if (signal?.aborted) {
    backendOwner.dispose();
    throw createRemoteConnectAbortError(signal);
  }

  let removeAbortListener: () => void = () => undefined;
  try {
    const connecting = connectRemoteUnchecked(backend, options, backendOwner);
    if (!signal) return await connecting;
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => {
        // 初始化取消与成功后的连接释放必须共用一个 backend owner；否则迟到连接
        // 再 dispose 会重复回收同一进程/连接。握手同时观察 signal，立即释放临时 reader。
        backendOwner.dispose();
        reject(createRemoteConnectAbortError(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      if (signal.aborted) onAbort();
    });
    const guardedConnecting = connecting.then((connection) => {
      if (signal.aborted) {
        connection.dispose();
        throw createRemoteConnectAbortError(signal);
      }
      return connection;
    });
    return await Promise.race([guardedConnecting, aborted]);
  } catch (error) {
    // detect/deploy/handshake 任一步失败时尚未返回 RemoteConnection，调用方无从回收 backend。
    backendOwner.dispose();
    throw error;
  } finally {
    removeAbortListener();
  }
}

async function connectRemoteUnchecked(
  backend: IRemoteBackend,
  options: ConnectOptions | undefined,
  backendOwner: RemoteBackendOwner,
): Promise<RemoteConnection> {
  const clientId = options?.clientId ?? `desktop-${Date.now()}`;

  const log = (...args: unknown[]) =>
    console.log(...safeLogArgs([formatLogPrefix("connectRemote", process.pid), ...args]));

  // 1. Detect remote environment
  log("detecting remote env...");
  const env = await backend.detect();
  throwIfRemoteConnectAborted(options?.signal);
  log("detected:", env);
  assertSupportedRemoteEnvironment(env);

  const remoteRuntimeNetwork = await resolveRemoteRuntimeNetwork(
    backend,
    options?.remoteRuntimeNetwork,
    log,
  );

  // 2. Deploy server if needed
  if (!options?.skipDeploy) {
    log("deploying server...");
    await deployServer(backend, env, options);
    throwIfRemoteConnectAborted(options?.signal);
    log("deploy complete");
  }

  // 3. Launch server
  log("launching remote server...");
  const stream = await backend.exec(buildRemoteServerCommand(options, remoteRuntimeNetwork));
  throwIfRemoteConnectAborted(options?.signal);
  log("remote server exec started");

  // Forward stderr for debugging; this listener belongs to the connection, not the backend.
  const diagnosticConsumer = createRemoteDiagnosticConsumer((args) => {
    console.log("[remote diagnostic]", ...args);
  });
  const stdout = stream.stdout as NodeJS.ReadableStream & {
    unshift(chunk: Buffer): void;
    destroyed?: boolean;
    readableEnded?: boolean;
    errored?: Error | null;
  };
  let socket: ISocket | undefined;
  let protocol: SocketProtocol | undefined;
  let client: ChannelClient | undefined;
  let hasReportedRemoteClose = false;
  let hasStreamClosed = false;
  let disposalStarted = false;
  let published = false;
  let backendDisconnectDisposable: IDisposable | undefined;
  let streamCloseDisposable: IDisposable | undefined;
  let disposeAndWaitInFlight: Promise<void> | null = null;
  let resolveStreamClosed!: () => void;
  const streamClosed = new Promise<void>((resolve) => {
    resolveStreamClosed = resolve;
  });
  const signal = options?.signal;
  const releaseCloseObservers = () => {
    streamCloseDisposable?.dispose();
    streamCloseDisposable = undefined;
    stdout.removeListener("end", onStdoutEnd);
    stdout.removeListener("close", onStdoutEnd);
    stdout.removeListener("error", onStdoutError);
  };
  const beginDisposal = () => {
    if (disposalStarted) return;
    disposalStarted = true;
    signal?.removeEventListener("abort", onAbort);
    backendDisconnectDisposable?.dispose();
    backendDisconnectDisposable = undefined;
    stream.stderr.removeListener("data", diagnosticConsumer);
    client?.dispose();
    protocol?.dispose();
    // 初始化关闭/取消后不能恢复无人消费的 flowing 输入；终态先就绪再 end stdin。
    if (!published) stdout.pause();
    socket?.dispose();
  };
  const disposeBackend = () => {
    releaseCloseObservers();
    backendOwner.dispose();
  };
  const disposeBackendAndWait = async () => {
    releaseCloseObservers();
    await backendOwner.disposeAndWait();
  };
  const reportRemoteClose = (code: number) => {
    if (hasReportedRemoteClose) return;
    hasReportedRemoteClose = true;
    // 被动断线也由同一连接 owner 收口；主动 disposeAndWait 的 EOF 不能抢 backend 回收顺序。
    if (!disposalStarted) {
      beginDisposal();
      disposeBackend();
    }
    options?.onDidRemoteClose?.({ code });
  };
  const onStreamClose = (code: number) => {
    hasStreamClosed = true;
    resolveStreamClosed();
    reportRemoteClose(code);
  };
  const onStdoutEnd = () => onStreamClose(BACKEND_DISCONNECT_EXIT_CODE);
  const onStdoutError = () => onStdoutEnd();
  const onAbort = () => {
    beginDisposal();
    disposeBackend();
  };
  const checkHandoff = () => {
    throwIfRemoteConnectAborted(signal);
    if (disposalStarted) throw new Error("Remote stream closed during RPC handoff");
  };

  try {
    // pause 只保全字节，不会延迟 nextTick error/close；连接 owner 必须在 ACK
    // callback 清掉握手监听之前就连续观察终态，不能在 await continuation 才补 listener。
    stdout.on("error", onStdoutError);
    checkHandoff();
    stdout.on("end", onStdoutEnd);
    checkHandoff();
    stdout.on("close", onStdoutEnd);
    checkHandoff();
    stream.stderr.on("data", diagnosticConsumer);
    // 4. Handshake owns all input until it pauses the validated hello boundary.
    log("performing handshake...");
    const { hello, remaining } = await performHandshake(
      stream,
      clientId,
      options?.handshakeTimeout,
      signal,
    );
    checkHandoff();
    log("handshake done, server version:", hello.version);

    // 5. 注册可同步补发关闭，迟到返回的句柄由同一终态释放；
    // 不能先构造 socket 再补生命周期监听。
    streamCloseDisposable = stream.onClose(onStreamClose);
    if (disposalStarted) releaseCloseObservers();
    checkHandoff();
    backendDisconnectDisposable = backend.onDidDisconnect?.((event) => {
      const message = event.error?.message;
      log(`remote backend disconnected: ${event.reason}${message ? `: ${message}` : ""}`);
      reportRemoteClose(BACKEND_DISCONNECT_EXIT_CODE);
    });
    if (disposalStarted) backendDisconnectDisposable?.dispose();
    checkHandoff();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    checkHandoff();
    if (stdout.errored || stdout.destroyed || stdout.readableEnded) onStdoutEnd();
    checkHandoff();
    if (remaining?.length) stdout.unshift(remaining);
    checkHandoff();

    socket = wrapStdioStream(stream);
    if (disposalStarted) socket.dispose();
    checkHandoff();
    // 同步绑定/恢复也可产生输入，只复用协议原有 ChunkStream，不建临时 reader 或缓存。
    protocol = new SocketProtocol(socket, { deferMessages: true });
    if (disposalStarted) protocol.dispose();
    checkHandoff();
    client = new ChannelClient(protocol);
    if (disposalStarted) client.dispose();
    checkHandoff();
    const services = new RemoteServiceAccess(client);
    checkHandoff();
    stdout.resume();
    if (disposalStarted) stdout.pause();
    checkHandoff();
    protocol.activate();
    checkHandoff();
    signal?.removeEventListener("abort", onAbort);
    published = true;

    return {
      services,
      client,
      dispose() {
        beginDisposal();
        disposeBackend();
      },
      disposeAndWait(disposeOptions) {
        if (disposeAndWaitInFlight) return disposeAndWaitInFlight;
        beginDisposal();
        // stdin.end 可同步补发 close；该 EOF 只满足等待条件，不能把已拥有的
        // 优雅回收降为 backend.dispose 并提前返回，仍必须等待同一 backend owner。
        if (backendOwner.disposed) {
          disposeBackend();
          return Promise.resolve();
        }
        if (hasStreamClosed) {
          disposeAndWaitInFlight = disposeBackendAndWait();
          return disposeAndWaitInFlight;
        }
        const timeoutMs = Math.max(disposeOptions?.timeoutMs ?? 5_000, 0);
        disposeAndWaitInFlight = (async () => {
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const deadline = new Promise<"timed-out">((resolve) => {
            timeout = setTimeout(() => resolve("timed-out"), timeoutMs);
          });
          const result = await Promise.race([streamClosed.then(() => "closed" as const), deadline]);
          if (timeout) clearTimeout(timeout);
          if (result === "timed-out") log(`remote stdio close timed out after ${timeoutMs}ms`);
          await disposeBackendAndWait();
        })();
        return disposeAndWaitInFlight;
      },
    };
  } catch (error) {
    beginDisposal();
    releaseCloseObservers();
    throw error;
  }
}

async function resolveRemoteRuntimeNetwork(
  backend: IRemoteBackend,
  network: RemoteRuntimeNetworkOptions | undefined,
  log: (...args: unknown[]) => void,
): Promise<RemoteRuntimeNetworkOptions | undefined> {
  if (!network || !backend.resolveRuntimeProxy) {
    // 只有实现了远端代理解析能力的 WSL backend 才接收这条权威网络边界；
    // SSH/Docker 即使误传 options 也保持原有启动命令。
    return undefined;
  }
  if (!network.httpProxy?.trim()) {
    return network;
  }

  try {
    const resolvedProxy = await backend.resolveRuntimeProxy(network.httpProxy);
    if (resolvedProxy !== network.httpProxy) {
      log(
        "resolved remote runtime proxy via wsl-host-gateway",
        formatWslProxyForLog(network.httpProxy),
        "->",
        formatWslProxyForLog(resolvedProxy),
      );
    }
    return { ...network, httpProxy: resolvedProxy };
  } catch (error) {
    // 代理解析只是运行时增强；解析失败时沿用设置页原值，避免把 WSL 本地工作区变成不可连接。
    log(
      "remote runtime proxy resolution failed; using configured endpoint",
      error instanceof Error ? error.message : String(error),
    );
    return network;
  }
}

function buildRemoteServerCommand(
  options: ConnectOptions | undefined,
  remoteRuntimeNetwork: RemoteRuntimeNetworkOptions | undefined,
): string {
  const envParts = [
    `${SERVICE_AUTHORITY_MODE_ENV}="desktop-attached-remote"`,
    'ZCODE_SERVER_RUNTIME_ROOT="$HOME/.zcodium/server"',
  ];
  for (const [key, value] of Object.entries(
    pickRemoteRuntimeEnv(options?.remoteRuntimeEnv ?? {}),
  )) {
    envParts.push(`${key}=${quotePosixShellArg(value)}`);
  }
  const appVersion = options?.appVersion?.trim();
  if (appVersion) {
    // 远端 server 是通过 SSH/WSL/Docker 单独启动的，不会继承桌面 host env。
    // 这里显式把 app 版本作为远端进程 env 注入，远端 agent 才能在模型请求 header 中带上版本。
    envParts.push(`${ZCODE_APP_VERSION_ENV}=${quotePosixShellArg(appVersion)}`);
  }
  if (remoteRuntimeNetwork?.authoritative) {
    envParts.push(`${ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY}='1'`);
    if (remoteRuntimeNetwork.httpProxy !== undefined) {
      envParts.push(
        `${ZCODE_REMOTE_HTTP_PROXY_ENV_KEY}=${quotePosixShellArg(remoteRuntimeNetwork.httpProxy)}`,
      );
    }
    if (remoteRuntimeNetwork.noProxy !== undefined) {
      envParts.push(
        `${ZCODE_REMOTE_NO_PROXY_ENV_KEY}=${quotePosixShellArg(remoteRuntimeNetwork.noProxy)}`,
      );
    }
  }
  return `${envParts.join(" ")} ~/.zcodium/server/node ~/.zcodium/server/zcode-server.cjs`;
}
