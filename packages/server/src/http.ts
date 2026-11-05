import { safeLogArgs } from "@zcode/shared";
/* eslint-disable max-lines -- HTTP、WebSocket 与静态资源路由集中注册，保持同一鉴权顺序。 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { hostname } from "node:os";
import { resolveServerOsUser } from "@zcode/shared/node";

import { basename, extname } from "node:path";
import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WebSocket } from "ws";
import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelServer,
  ChannelClient,
  LoggingChannelServer,
  type ISocket,
} from "@zcode/rpc";
import type { TopicResourcePeers } from "@zcode/services/node";
import { TOPIC_RESOURCE_RELAY_CHANNEL } from "@zcode/shared";
import {
  ServiceCollection,
  IZCodeAgentService,
  createZCodeAgentConnectionScope,
  IFileService,
  IGitService,
  ISystemService,
  ITerminalService,
  IBotsService,
  IProviderProvisioningTargetService,
  IConversationShareService,
} from "@zcode/services";
import {
  botProviders,
  remoteTargetSchema,
  formatLogPrefix,
  serverRemoteInfoOutputSchema,
  SERVER_REMOTE_PROTOCOL_VERSION,
  ZCODE_RPC_HOST_CAPABILITY_HEADER,
  ZCODE_COMPATIBILITY_MANIFEST,
  ZCODE_VERSION,
  type BotProvider,
  type ServerRemoteInfo,
  type ServerRemoteWorkspaceInfo,
} from "@zcode/shared";
import {
  SourceServerWorkspaceIdentityChannelServer,
  scopeConversationShareServiceForAttachment,
  type SourceServerWorkspaceIdentityMapper,
} from "@zcode/services/node";
import { createHostCapabilityStore } from "./hostCapability.js";
import { connectRemote, createRemoteBackend, type RemoteConnection } from "./remote/index.js";
import { resolveStaticFile } from "./httpStaticFiles.js";

function wrapWebSocket(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    onData.fire(VSBuffer.wrap(new Uint8Array(buf)));
  });
  ws.on("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  ws.on("error", () => {
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws.readyState === ws.OPEN) {
        ws.send(buffer.buffer);
      }
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.close();
    },
  };
}

const log = (...args: unknown[]) =>
  console.log(...safeLogArgs([formatLogPrefix("zcode-server:http", process.pid), ...args]));

function setupChannelServer(
  ws: WebSocket,
  services: ServiceCollection,
  clientMode: "desktop-continuous" | "web-remote-replayable",
  workspaceIdentityMapper?: SourceServerWorkspaceIdentityMapper,
  resourcePeers?: TopicResourcePeers,
) {
  const socket = wrapWebSocket(ws);
  const protocol = new SocketProtocol(socket);
  const rawServer = new ChannelServer(protocol, "server");
  // 用日志中间件包装，统一记录所有 RPC 调用
  const loggedServer = new LoggingChannelServer(rawServer, log);
  const server = workspaceIdentityMapper
    ? new SourceServerWorkspaceIdentityChannelServer(loggedServer, workspaceIdentityMapper)
    : loggedServer;
  const agentService = services.getOptional(IZCodeAgentService);
  const reverseClient =
    clientMode === "desktop-continuous" && resourcePeers ? new ChannelClient(protocol) : undefined;
  const peer = reverseClient
    ? resourcePeers?.attach(reverseClient.getChannel(TOPIC_RESOURCE_RELAY_CHANNEL))
    : undefined;
  const connectionContext = {
    connectionId: `server-ws-${randomUUID()}`,
    clientMode,
    role:
      clientMode === "desktop-continuous"
        ? ("trusted-host-relay" as const)
        : ("terminal-client" as const),
  };
  const connectionScope = agentService
    ? createZCodeAgentConnectionScope(
        peer ? peer.wrapAgent(agentService) : agentService,
        connectionContext,
      )
    : undefined;
  const overrides = new Map<string, unknown>();
  if (connectionScope) {
    overrides.set(IZCodeAgentService.channelName, connectionScope.service);
  }
  const shareService = services.getOptional(IConversationShareService);
  if (shareService) {
    // HTTP 与 stdio 必须共用 attachment 准入；直接暴露 base service 会让 Web 调到桌面归档。
    overrides.set(
      IConversationShareService.channelName,
      scopeConversationShareServiceForAttachment(
        shareService,
        clientMode,
        connectionScope?.service,
        connectionContext,
      ),
    );
  }
  // Provisioning 携带跨 Environment 凭据，只允许 Desktop trusted host 使用；普通 Web
  // remote/replayable 客户端即使知道频道名，也不能获得 target 写入接口。
  if (
    clientMode !== "desktop-continuous" &&
    services.getOptional(IProviderProvisioningTargetService)
  ) {
    overrides.set(IProviderProvisioningTargetService.channelName, {
      apply: async () => {
        throw new Error("Provider Provisioning 仅支持受信 Desktop Host");
      },
    });
  }
  services.exposeOnChannelServer(server, overrides);
  socket.onClose(() => {
    peer?.dispose();
    reverseClient?.dispose();
    rawServer.dispose();
    // 连接 owner 必须同时释放协议，单独结束 server 不会清掉未收完整的大帧。
    protocol.dispose();
    void connectionScope?.dispose();
  });
}

function generateId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

interface HttpServerOptions {
  /** 服务启动入口拥有本地资源目录，HTTP 连接请求不能覆盖。 */
  bundledRemoteAssetsDir?: string;
  serverId?: string;
  virtualProjects?: boolean;
  migrationFailedPathCount?: number;
  workspaceIdentityMapper?: SourceServerWorkspaceIdentityMapper;
  topicResourcePeers?: TopicResourcePeers;
  name?: string;
  host?: string;
  authRequired?: boolean;
  authToken?: string;
  spaFallback?: boolean;
  staticRoot?: string;
  workspaces?: ServerRemoteWorkspaceInfo[];
}

function readTrimmedEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function resolveHttpServerId(options: HttpServerOptions = {}): string {
  return (
    options.serverId?.trim() || readTrimmedEnv("ZCODE_SERVER_ID") || hostname() || "zcode-server"
  );
}

function resolveServerWorkspaces(options: HttpServerOptions): ServerRemoteWorkspaceInfo[] {
  if (options.workspaces) {
    return options.workspaces;
  }
  const workspacePath = readTrimmedEnv("ZCODE_SERVER_WORKSPACE") || process.cwd();
  return [
    {
      path: workspacePath,
      label: basename(workspacePath) || workspacePath,
    },
  ];
}

function createServerInfo(options: HttpServerOptions): ServerRemoteInfo {
  return serverRemoteInfoOutputSchema.parse({
    serverId: resolveHttpServerId(options),
    ...(options.name?.trim() || readTrimmedEnv("ZCODE_SERVER_NAME")
      ? { name: options.name?.trim() || readTrimmedEnv("ZCODE_SERVER_NAME") }
      : {}),
    version: ZCODE_VERSION,
    protocolVersion: SERVER_REMOTE_PROTOCOL_VERSION,
    authRequired: options.authRequired ?? Boolean(readTrimmedEnv("ZCODE_SERVER_TOKEN")),
    workspaces: resolveServerWorkspaces(options),
    compatibility: ZCODE_COMPATIBILITY_MANIFEST,
    migration: { failedPathCount: options.migrationFailedPathCount ?? 0 },
    identity: { osUser: resolveServerOsUser(), hostname: hostname() },
    capabilities: {
      desktopContinuous: true,
      websocketRpc: true,
    },
  });
}

const zcodeLiteTokenCookieName = "zcode_lite_token";

const staticMimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function parseCookieHeader(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) {
    return cookies;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) {
      cookies.set(name, value);
    }
  }
  return cookies;
}

function hasValidLiteToken(c: Context, token: string): boolean {
  const authorization = c.req.header("authorization");
  if (
    authorization?.startsWith("Bearer ") &&
    authorization.slice("Bearer ".length).trim() === token
  ) {
    return true;
  }
  const url = new URL(c.req.url);
  if (url.searchParams.get("token") === token) {
    c.header(
      "Set-Cookie",
      `${zcodeLiteTokenCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`,
    );
    return true;
  }
  return parseCookieHeader(c.req.header("cookie")).get(zcodeLiteTokenCookieName) === token;
}

function isTokenProtectedPath(pathname: string): boolean {
  return pathname === "/ws" || pathname.startsWith("/ws/") || pathname.startsWith("/api/");
}

function isStaticFallbackAllowed(pathname: string): boolean {
  return !isTokenProtectedPath(pathname);
}

function staticContentType(filePath: string): string {
  return staticMimeTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export function createHttpServer(
  services: ServiceCollection,
  port = 3030,
  options: HttpServerOptions = {},
) {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket, wss } = createNodeWebSocket({ app });
  const hostCapabilities = createHostCapabilityStore();
  // 一个 HTTP 实例独占准备、待绑定和已绑定连接；模块全局 Map 会令其他实例消费同一 ID。
  const remoteConnections = new Map<string, RemoteConnection>();
  const ownedRemoteConnections = new Set<RemoteConnection>();
  const connectControllers = new Set<AbortController>();
  const connectFlights = new Set<Promise<void>>();
  const releaseFlights = new Set<Promise<void>>();
  const releasedConnections = new WeakMap<RemoteConnection, Promise<void>>();
  let closing = false;
  const releaseRemote = (connection: RemoteConnection): Promise<void> => {
    const existing = releasedConnections.get(connection);
    if (existing) return existing;
    ownedRemoteConnections.delete(connection);
    const released = Promise.resolve()
      .then(() => connection.disposeAndWait())
      .catch(() => log("remote connection release failed"));
    releasedConnections.set(connection, released);
    releaseFlights.add(released);
    void released.finally(() => releaseFlights.delete(released));
    return released;
  };
  app.use("*", async (c, next) => {
    if (closing) return c.json({ error: "Server shutting down" }, 503);
    await next();
  });

  const authToken = options.authToken?.trim();
  if (authToken) {
    app.use("*", async (c, next) => {
      const pathname = new URL(c.req.url).pathname;
      const validToken = hasValidLiteToken(c, authToken);
      if (!isTokenProtectedPath(pathname) || validToken) {
        await next();
        return;
      }
      return c.json({ error: "Unauthorized" }, 401);
    });
  }

  app.get("/api/server-info", (c) => c.json(createServerInfo(options)));
  app.post("/api/rpc-host-capability", (c) => c.json(hostCapabilities.issue()));

  // 普通 `/ws` 永远是 terminal-client；浏览器/任意客户端设置旧 mode header
  // 都不能再把自己提升为 trusted host。
  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        setupChannelServer(
          ws.raw as WebSocket,
          services,
          "web-remote-replayable",
          options.workspaceIdentityMapper,
        );
      },
    })),
  );

  const upgradeTrustedHostWebSocket = upgradeWebSocket(() => ({
    onOpen(_event, ws) {
      setupChannelServer(
        ws.raw as WebSocket,
        services,
        "desktop-continuous",
        options.workspaceIdentityMapper,
        options.topicResourcePeers,
      );
    },
  }));
  app.use("/ws/host", async (c, next) => {
    const capability = c.req.header(ZCODE_RPC_HOST_CAPABILITY_HEADER);
    if (!hostCapabilities.consume(capability)) {
      return c.json({ error: "Invalid or expired host capability" }, 401);
    }
    await next();
  });
  app.get("/ws/host", upgradeTrustedHostWebSocket);

  // 显式Web连接只使用用户预部署服务；不能借旧HTTP入口恢复自动资源安装。
  app.post("/api/connect-remote", async (c) => {
    const parsed = remoteTargetSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || parsed.data.kind === "server")
      return c.json({ error: "Invalid remote target" }, 400);
    if (closing) return c.json({ error: "Server shutting down" }, 503);
    const controller = new AbortController();
    connectControllers.add(controller);
    let finish!: () => void;
    const flight = new Promise<void>((done) => {
      finish = done;
    });
    connectFlights.add(flight);
    try {
      const backend = await createRemoteBackend(parsed.data);
      if (closing) {
        if (backend.disposeAndWait) await backend.disposeAndWait();
        else backend.dispose();
        return c.json({ error: "Server shutting down" }, 503);
      }
      const connection = await connectRemote(backend, {
        skipDeploy: true,
        signal: controller.signal,
      });
      ownedRemoteConnections.add(connection);
      // 取消可与握手完成交错；迟到资源仍由本次 flight 释放，不能重新发布可消费 ID。
      if (closing) {
        await releaseRemote(connection);
        return c.json({ error: "Server shutting down" }, 503);
      }
      const id = generateId();
      remoteConnections.set(id, connection);
      return c.json({ id });
    } catch {
      return closing
        ? c.json({ error: "Server shutting down" }, 503)
        : c.json({ error: "Remote connection failed" }, 500);
    } finally {
      connectControllers.delete(controller);
      connectFlights.delete(flight);
      finish();
    }
  });

  const handleBotCallback = async (c: Context) => {
    const provider = c.req.param("provider") as BotProvider;
    if (!botProviders.includes(provider)) {
      return c.json({ error: `Unsupported provider: ${provider}` }, 400);
    }
    if (provider !== "webhook") {
      return c.json({ error: `Provider ${provider} does not support HTTP callbacks.` }, 400);
    }
    const botsService = services.getOptional(IBotsService);
    if (!botsService) {
      return c.json({ error: "Bots service is not available." }, 503);
    }
    const rawBodyText = await c.req.text().catch(() => "");
    let rawBody: unknown = {};
    if (rawBodyText) {
      try {
        rawBody = JSON.parse(rawBodyText) as unknown;
      } catch {
        rawBody = { payload: rawBodyText };
      }
    }
    const webhookSecret = c.req.header("x-zcode-bot-secret");
    const botId = c.req.param("botId");
    const result = await botsService.handleProviderCallbackResponse(provider, {
      ...(typeof rawBody === "object" && rawBody !== null ? rawBody : { payload: rawBody }),
      rawBody: rawBodyText,
      ...(botId ? { botId } : {}),
      ...(webhookSecret ? { webhookSecret } : {}),
    });
    const responseBody = result.responseBody ?? { ok: result.ok, replies: result.replies };
    if (result.status === 400) {
      return c.json(responseBody, 400);
    }
    if (result.status === 401) {
      return c.json(responseBody, 401);
    }
    if (result.status === 503) {
      // Bugfix：Bot 业务失败必须把可重试状态透传给 HTTP provider；返回 200 会让
      // webhook/网关误以为消息已消费，效果与提前提交 Telegram offset 相同。
      return c.json(responseBody, 503);
    }
    return c.json(responseBody, 200);
  };

  app.post("/api/bots/:provider", handleBotCallback);
  app.post("/api/bots/:provider/:botId", handleBotCallback);

  // 远程连接的 WebSocket 端点，将远程 services 桥接给浏览器
  app.get(
    "/ws/remote/:id",
    upgradeWebSocket((c) => {
      const id = c.req.param("id");
      return {
        onOpen(_event, ws) {
          if (!id) {
            ws.close(4000, "Missing remote connection id");
            return;
          }
          const connection = remoteConnections.get(id);
          if (!connection) {
            ws.close(4004, "Remote connection not found");
            return;
          }
          // 一个连接只给一个 WS 客户端使用，取出后从 Map 移除
          remoteConnections.delete(id);
          const rawSocket = ws.raw as WebSocket;
          rawSocket.once("close", () => {
            void releaseRemote(connection);
          });
          rawSocket.once("error", () => {
            void releaseRemote(connection);
          });

          // 将远程 services 包装为 ServiceCollection，复用 exposeOnChannelServer 统一注册
          const remoteServices = new ServiceCollection()
            .register(IFileService, connection.services.fileService)
            .register(IGitService, connection.services.gitService)
            .register(ISystemService, connection.services.systemService)
            .register(ITerminalService, connection.services.terminalService);

          setupChannelServer(ws.raw as WebSocket, remoteServices, "web-remote-replayable");
        },
      };
    }),
  );

  if (options.staticRoot?.trim()) {
    const staticRoot = options.staticRoot.trim();
    app.get("*", async (c) => {
      const pathname = new URL(c.req.url).pathname;
      const filePath = await resolveStaticFile(
        staticRoot,
        pathname,
        (options.spaFallback ?? true) && isStaticFallbackAllowed(pathname),
      );
      if (!filePath) {
        return c.notFound();
      }
      return c.body(await readFile(filePath), 200, {
        "Cache-Control": filePath.endsWith("index.html")
          ? "no-cache"
          : "public, max-age=31536000, immutable",
        "Content-Type": staticContentType(filePath),
      });
    });
  }

  // 当前入口只使用 serve 默认的 node:http 工厂，没有 HTTP/2 或自定义 server 注入；
  // 具体 HTTP 类型使 close 的返回值与该实例一致，不能沿库的多工厂联合签名覆盖方法。
  const server = serve({ fetch: app.fetch, hostname: options.host, port }, () => {
    const address = server.address();
    const listenPort = typeof address === "object" && address ? address.port : port;
    const listenHost = options.host?.trim() || "localhost";
    log(`http://${listenHost}:${listenPort}`);
  }) as HttpServer;

  injectWebSocket(server);

  // 原生 HTTP close 不处理 upgrade socket。关闭从同步退休开始，callback 还要等待
  // 同一实例的迟到准备结果及 disposeAndWait，防止先宣告退出、后遗留远端进程。
  wss.on("connection", (socket) => {
    if (closing) socket.terminate();
  });
  const nativeClose = server.close.bind(server);
  let closeFlight: Promise<void> | undefined;
  server.close = (callback?: (error?: Error) => void) => {
    if (!closeFlight) {
      closing = true;
      for (const controller of connectControllers) controller.abort();
      remoteConnections.clear();
      const httpClosed = new Promise<void>((done, reject) => {
        nativeClose((error?: Error) => (error ? reject(error) : done()));
      });
      for (const socket of wss.clients) socket.terminate();
      const socketsClosed = new Promise<void>((done, reject) => {
        wss.close((error?: Error) => (error ? reject(error) : done()));
      });
      const remotesClosed = (async () => {
        // 准备中的连接有独立 flight owner；不能让其迟到握手阻塞已建立连接开始释放。
        // 当前连接立即回收，迟到连接仍在原 flight 内释放，最后等待同一 release 集合。
        const readyRemotesClosed = Promise.all([...ownedRemoteConnections].map(releaseRemote));
        await Promise.all(connectFlights);
        await readyRemotesClosed;
        await Promise.all(releaseFlights);
      })();
      closeFlight = Promise.all([httpClosed, socketsClosed, remotesClosed]).then(() => undefined);
    }
    void closeFlight.then(
      () => callback?.(),
      (error: Error) => callback?.(error),
    );
    return server;
  };

  return server;
}
