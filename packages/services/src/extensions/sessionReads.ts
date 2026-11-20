import { readOneShotInteractions } from "./sessionReadOneShot.js";
import { createSessionMirrorFlow } from "./sessionMirrorFlow.js";
import type { AppSessionRef } from "@zcode/session-control/contracts";
import {
  EXTENSION_API_VERSION,
  ExtensionError,
  MAX_SESSION_MIRRORS,
  MAX_SESSION_SUBSCRIPTIONS_PER_PLUGIN,
  type SessionConversationEvent,
  type SessionInteractionsEvent,
  type SessionRowsEvent,
  type SessionTargetInput,
} from "@zcode/shared/extension-host";
import {
  TopicWireFrameAssembler,
  V4_WIRE_PROTOCOL_VERSION,
  conversationTopic,
  conversationTopicFrameSchema,
} from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeAgentWorkspaceTarget } from "#src/zcode-agent/zcodeAgent.js";
import { createZCodeAgentConnectionScope } from "#src/zcode-agent/zcodeAgentConnectionScope.js";
import type {
  CapabilityCallContext,
  CapabilitySubscription,
} from "#src/extensions/capabilityTypes.js";
import { createSessionListPump } from "#src/extensions/sessionListPump.js";
import {
  type SessionReadsDeps,
  type SessionInteractionsRead,
  type SessionReads,
  type Target,
  type Registration,
  type Mirror,
  type Connection,
} from "./sessionReadTypes.js";
import { workspaceKeyOf, describe } from "./sessionReadFacts.js";

export {
  type SessionReadsDeps,
  type SessionInteractionsRead,
  type SessionReads,
} from "./sessionReadTypes.js";

export function createSessionReads(deps: SessionReadsDeps): SessionReads {
  const { logger } = deps;
  const list = createSessionListPump({
    taskRows: deps.taskRows,
    localSourceServerId: deps.localSourceServerId,
    logger,
  });
  let connection: Connection | null = null;
  const mirrors = new Map<string, Mirror>();
  const registrations = new Set<Registration>();
  const {
    deliver,
    deliverRows,
    resetEvent,
    stateOf,
    interactionsOf,
    acceptWire,
    subscribe,
    closeMirror,
  } = createSessionMirrorFlow(() => connection, mirrors, registrations, logger);

  // —— 连接作用域：每个代际一份，第一次读正文时创建 ——

  const connect = (gen: number): Connection => {
    if (connection?.gen === gen) return connection;
    if (deps.currentGen() !== gen)
      throw new ExtensionError("cancelled", "the extension host generation changed");
    if (!deps.agent) throw new ExtensionError("unavailable", "session reads are unavailable");
    releaseConnection("replaced");
    const agent = deps.agent;
    const connectionId = `extension-host:${gen}`;
    const scope = createZCodeAgentConnectionScope(agent, {
      connectionId,
      clientMode: "web-remote-replayable",
    });
    const ready = (async () => {
      await scope.service.helloConversationV4();
      await scope.service.initializeConversationV4({
        kind: "clientHello",
        protocolVersion: V4_WIRE_PROTOCOL_VERSION,
        clientId: "extension-host",
        appVersion: `extension-host/${EXTENSION_API_VERSION}`,
      });
    })();
    void ready.catch(() => undefined);
    const next: Connection = { gen, scope, ready, workspaces: new Map(), runtime: [] };
    // 运行时重启后旧订阅全部失效（scope 已忘掉 owner）：该工作区的镜像重新订阅，第一个事件是 reset。
    next.runtime.push(
      scope.service.onAgentRuntimeRestarted(({ workspaceKey }) => {
        for (const mirror of mirrors.values()) {
          if (workspaceKeyOf(mirror.target) === workspaceKey)
            subscribe(mirror, "runtime restarted");
        }
      }),
    );
    connection = next;
    logger.info(undefined, `session read connection open connectionId=${connectionId}`);
    return next;
  };

  const releaseConnection = (reason: string) => {
    const current = connection;
    if (!current) return;
    connection = null;
    for (const mirror of mirrors.values()) closeMirror(mirror, false);
    for (const disposables of current.workspaces.values()) {
      for (const disposable of disposables) disposable.dispose();
    }
    for (const disposable of current.runtime) disposable.dispose();
    // scope.dispose() 向 CLI 退订本连接的全部订阅（与手机断开相同）。
    void current.scope.dispose().catch((error: unknown) => {
      logger.warn(undefined, `session read connection dispose failed (${describe(error)})`);
    });
    logger.info(
      undefined,
      `session read connection closed connectionId=extension-host:${current.gen} (${reason})`,
    );
  };

  /** 每个工作区只挂一次帧流与生命周期流；按 topic 交给镜像。 */
  const watchWorkspace = (current: Connection, target: ZCodeAgentWorkspaceTarget) => {
    const key = workspaceKeyOf(target);
    if (current.workspaces.has(key)) return;
    const workspace: ZCodeAgentWorkspaceTarget = {
      workspacePath: target.workspacePath,
      ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
    };
    current.workspaces.set(key, [
      current.scope.service.onDynamicConversationFrame(workspace)((wire) => {
        for (const mirror of mirrors.values()) {
          if (mirror.topic === wire.topic && workspaceKeyOf(mirror.target) === key)
            acceptWire(mirror, wire);
        }
      }),
      current.scope.service.onDynamicSessionLifecycle(workspace)((snapshot) => {
        const mirror = mirrors.get(`${key}\0${snapshot.sessionId}`);
        if (!mirror || snapshot.revision < mirror.lifecycleRevision) return;
        mirror.lifecycleRevision = snapshot.revision;
        if (snapshot.state === "stopping" || snapshot.state === "faulted") {
          // 会话在停：scope 已忘掉这条订阅。镜像保留快照，等会话再启动时重新订阅。
          mirror.attempt += 1;
          mirror.phase = "detached";
          mirror.subscriptionId = null;
          mirror.assembler.clear();
          logger.info(undefined, `session mirror detached session=${mirror.target.sessionId}`);
          return;
        }
        if (
          mirror.phase === "detached" &&
          (snapshot.state === "starting" || snapshot.state === "ready")
        ) {
          subscribe(mirror, `session ${snapshot.state}`);
        }
      }),
    ]);
  };

  // —— 登记：上限、解析、挂到镜像 ——

  /** 会话目标经 facade 解析：与 sessions.readSession 同一份授权与代际检查，只读本机来源。 */
  const resolve = async (
    call: CapabilityCallContext,
    sessionId: string,
    capabilityId: string,
    kind?: Registration["kind"],
  ): Promise<Target> => {
    // 交互一类的能力是写档：解析会话只是读，按 readSession 走（不写审计行；审计由调用方的写动作写一次）。
    const runAs = kind === "interactions" ? "sessions.readSession" : capabilityId;
    const result = await deps.sessions.run(call, runAs, (ctx, control) =>
      control.readSession(ctx, { sessionId, view: "summary" }),
    );
    if (result.view !== "summary") throw new ExtensionError("internal", "unexpected session view");
    const session = result.summary.session as AppSessionRef;
    if (session.kind !== "app" || session.sourceServerId !== deps.localSourceServerId())
      throw new ExtensionError("forbidden", "only sessions on this device can be read");
    // 交互与权限模式只对插件项目里的会话开放（§17.12）：在挂镜像之前检查。
    if (kind === "interactions") {
      if (!deps.controlScope)
        throw new ExtensionError("forbidden", "session approvals are not available");
      await deps.controlScope(call.pluginId, session);
    }
    return {
      workspacePath: session.workspacePath,
      ...(session.workspaceIdentity ? { workspaceIdentity: session.workspaceIdentity } : {}),
      sessionId: session.sessionId,
    };
  };

  const attach = (registration: Registration, target: Target, gen: number) => {
    const current = connect(gen);
    const key = `${workspaceKeyOf(target)}\0${target.sessionId}`;
    let mirror = mirrors.get(key);
    if (!mirror) {
      if (mirrors.size >= MAX_SESSION_MIRRORS)
        throw new ExtensionError(
          "limit-exceeded",
          `at most ${MAX_SESSION_MIRRORS} sessions can be read at the same time`,
        );
      mirror = {
        key,
        target,
        topic: conversationTopic(target.sessionId),
        assembler: new TopicWireFrameAssembler(conversationTopicFrameSchema),
        registrations: new Set(),
        attempt: 0,
        phase: "subscribing",
        subscriptionId: null,
        snapshot: null,
        rowBytes: new Map(),
        totalBytes: 0,
        stateKey: null,
        interactionsKey: null,
        lifecycleRevision: 0,
      };
      mirrors.set(key, mirror);
      watchWorkspace(current, target);
      subscribe(mirror, `first listener plugin=${registration.pluginId}`);
    }
    registration.mirror = mirror;
    mirror.registrations.add(registration);
    // 镜像已有快照：新的监听先收当前值（与镜像第一次收到快照时相同）。
    const snapshot = mirror.snapshot;
    if (snapshot && (mirror.phase === "live" || mirror.phase === "resyncing")) {
      if (registration.kind === "rows") deliverRows(mirror, resetEvent(snapshot), registration);
      else if (registration.kind === "interactions")
        deliver(mirror, "interactions", interactionsOf(mirror, snapshot), registration);
      else deliver(mirror, "conversation", stateOf(mirror, snapshot), registration);
    }
  };

  const release = (registration: Registration) => {
    if (registration.disposed) return;
    registration.disposed = true;
    registrations.delete(registration);
    const mirror = registration.mirror;
    if (!mirror) return;
    mirror.registrations.delete(registration);
    if (mirror.registrations.size === 0) closeMirror(mirror, true);
  };

  /**
   * 登记一个监听：上限按插件的不同会话数算（会话状态、行与交互合计），在解析前同步检查；
   * 解析（含范围检查）成功后挂到镜像。失败时以 fail 结束。返回登记（已失败时为 null）。
   */
  const admitRegistration = (
    call: CapabilityCallContext,
    input: SessionTargetInput,
    kind: Registration["kind"],
    capabilityId: string,
    listener: (event: never) => void,
    fail: (error: ExtensionError) => void,
    oneShot = false,
  ): Registration | null => {
    const sessions = new Set(
      [...registrations]
        .filter((entry) => entry.pluginId === call.pluginId)
        .map((entry) => entry.sessionId),
    );
    if (!sessions.has(input.sessionId) && sessions.size >= MAX_SESSION_SUBSCRIPTIONS_PER_PLUGIN) {
      fail(
        new ExtensionError(
          "limit-exceeded",
          `at most ${MAX_SESSION_SUBSCRIPTIONS_PER_PLUGIN} sessions per plugin can be subscribed`,
        ),
      );
      return null;
    }
    const registration: Registration = {
      pluginId: call.pluginId,
      sessionId: input.sessionId,
      kind,
      ...(oneShot ? { oneShot } : {}),
      listener,
      fail,
      mirror: null,
      disposed: false,
    };
    registrations.add(registration);
    void resolve(call, input.sessionId, capabilityId, kind)
      .then((target) => {
        if (registration.disposed) return;
        attach(registration, target, call.gen);
      })
      .catch((error: unknown) => {
        if (registration.disposed) return;
        registration.disposed = true;
        registrations.delete(registration);
        fail(
          error instanceof ExtensionError
            ? error
            : new ExtensionError("unavailable", "the session is not available to read"),
        );
      });
    return registration;
  };

  const register =
    <E>(kind: Registration["kind"], capabilityId: string) =>
    (call: CapabilityCallContext, input: SessionTargetInput): CapabilitySubscription<E> =>
    (listener, fail) => {
      const registration = admitRegistration(
        call,
        input,
        kind,
        capabilityId,
        listener as (event: never) => void,
        fail,
      );
      return { dispose: () => (registration ? release(registration) : undefined) };
    };

  return {
    async readRows(call, input) {
      const target = await resolve(call, input.sessionId, "sessions.readRows");
      const current = connect(call.gen);
      try {
        await current.ready;
        const result = await current.scope.service.conversationRowsRangeV4({
          workspacePath: target.workspacePath,
          ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
          sessionId: target.sessionId,
          ...(input.beforeRowId !== undefined ? { beforeRowId: input.beforeRowId } : {}),
          limit: input.limit,
        });
        return {
          logEpoch: result.atLogEpoch,
          revision: result.atRevision,
          rows: result.rows,
          hasMore: result.hasMore,
        };
      } catch (error) {
        // 原始错误文本可能带路径：日志与扩展都只拿错误码。
        logger.warn(undefined, `sessions.readRows failed (${describe(error)})`);
        throw new ExtensionError("unavailable", "the session rows are not available to read");
      }
    },
    onDidChangeList: (call) => list.subscribe(call.pluginId),
    onDidChangeConversation: register<SessionConversationEvent>(
      "conversation",
      "sessions.onDidChangeConversation",
    ),
    onDidChangeRows: register<SessionRowsEvent>("rows", "sessions.onDidChangeRows"),
    onDidChangeInteractions: register<SessionInteractionsEvent>(
      "interactions",
      "sessions.onDidChangeInteractions",
    ),
    readInteractions: (call, sessionId) =>
      readOneShotInteractions(call, sessionId, admitRegistration, release),
    detach() {
      // 网关的订阅随 RPC 服务端一起释放；这里先清登记，再释放镜像与作用域。
      // 一次性读取没有 RPC 订阅兜底：以 cancelled 结束，调用方据此报告换代。
      for (const registration of registrations) {
        registration.disposed = true;
        if (registration.oneShot)
          registration.fail(
            new ExtensionError("cancelled", "the extension host generation changed"),
          );
      }
      registrations.clear();
      releaseConnection("extension host detached");
    },
    dispose() {
      this.detach();
      list.dispose();
    },
  };
}
