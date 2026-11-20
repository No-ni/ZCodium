import { buildCliRuntimeControl } from "./runtimeControl.js";
import { submitToCliRoot } from "./runtimeSubmission.js";
import type { RuntimeMethodContext } from "./runtimeMethodContext.js";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  createRootTraceContext,
  SessionEventType,
  type MessageWithParts,
  type SessionId,
  type SessionInfo,
  type TraceContext,
  type TraceId,
} from "@zcode/contracts";
import {
  SessionControlError,
  type AccessGrant,
  type CliScope,
  type CliSessionRef,
  type CliTrustedContext,
  type SessionSummary,
} from "@zcode/session-control/contracts";
import type { ZCodeApp } from "../app/types.js";
import {
  isTranscriptVisibleMessage,
  projectActiveSessionMessages,
} from "../active-transcript/index.js";
import type { CliSessionControlRuntime, CliSessionControlRuntimeOptions } from "./contract.js";
import { CliOperationObservations } from "./observation.js";
import {
  MAX_LISTED_SESSIONS,
  DEFAULT_MAX_REQUESTS,
  DEFAULT_MAX_ROOTS,
  CLOSE_REASON,
  NO_OWNER,
  ROOT_ACTIONS,
  type Root,
  type RequestReceipt,
  scopeKey,
  digest,
} from "./runtimeFacts.js";

export type {
  CliRootAppRequest,
  CliSessionControlRuntime,
  CliSessionControlRuntimeOptions,
} from "./contract.js";

export function createCliSessionControlRuntime(
  options: CliSessionControlRuntimeOptions,
): CliSessionControlRuntime {
  const epoch = randomUUID();
  const maxRequests = options.limits?.requests ?? DEFAULT_MAX_REQUESTS;
  const maxRoots = options.limits?.roots ?? DEFAULT_MAX_ROOTS;
  if (![maxRequests, maxRoots].every((value) => Number.isSafeInteger(value) && value > 0))
    throw new SessionControlError("invalid_input", "CLI owner capacity must be a positive integer");
  let rootReservations = 0;
  const workspace: CliScope = {
    ...options.workspace,
    workspacePath: resolve(options.workspace.workspacePath),
  };
  const roots = new Map<string, Root>();
  // 这是创建/请求 owner 的回执，不是第二份 accepted input queue；执行队列仍只归 Core。
  const receipts = new Map<string, RequestReceipt>();
  const observations = new CliOperationObservations(epoch);
  const pendingMutations = new Set<Promise<unknown>>();
  let closing = false;
  let closePromise: Promise<void> | undefined;

  function assertOpen(): void {
    if (closing)
      throw new SessionControlError("unavailable", "CLI session control owner is closed");
  }
  function ref(sessionId: string): CliSessionRef {
    return { ...workspace, sessionId };
  }
  function owner(session: CliSessionRef): Root {
    if (
      scopeKey(session) !== scopeKey(workspace) ||
      resolve(session.workspacePath) !== workspace.workspacePath
    )
      throw new SessionControlError("forbidden", "Session workspace does not match this owner");
    const root = roots.get(session.sessionId);
    if (!root) throw new SessionControlError("unavailable", NO_OWNER);
    return root;
  }
  function writable(session: CliSessionRef): Root {
    const root = owner(session);
    // 关闭责任与来源证明独立；只有来源不明的恢复历史不能反向变成控制目标。
    if (root.failure) throw new SessionControlError("unavailable", root.failure);
    if (!root.verified)
      throw new SessionControlError(
        "unavailable",
        "Session source is not verified as an independent CLI root",
      );
    return root;
  }
  function reserveRoot(): void {
    if (roots.size + rootReservations >= maxRoots)
      throw new SessionControlError("unavailable", "CLI root capacity reached");
    rootReservations += 1;
  }
  function fence(ctx: CliTrustedContext): string {
    return digest([epoch, ctx.callerId, ctx.rootSession]);
  }
  function validate(ctx: CliTrustedContext, grant: AccessGrant<CliScope>): void {
    assertOpen();
    owner(ctx.rootSession);
    if (
      grant.fence !== fence(ctx) ||
      scopeKey(grant.scope) !== scopeKey(workspace) ||
      !ctx.allowedScopes.some((scope) => scopeKey(scope) === scopeKey(workspace))
    ) {
      throw new SessionControlError(
        "forbidden",
        "CLI authorization scope or owner generation changed",
      );
    }
  }
  // 读本机会话库只要求调用者 fence 有效；写操作仍用 validate 校验 owner 与 workspace。
  function validateRead(ctx: CliTrustedContext, grant: AccessGrant<CliScope>): void {
    if (!ctx.readAnyLocalSession) return validate(ctx, grant);
    assertOpen();
    owner(ctx.rootSession);
    if (grant.fence !== fence(ctx))
      throw new SessionControlError("forbidden", "CLI owner generation changed");
  }
  async function listStored(filter?: CliScope): Promise<SessionSummary<CliSessionRef>[]> {
    const stored = await options.sessionStore.listSessions({
      roots: true,
      ...(filter ? { directory: resolve(filter.workspacePath) } : {}),
      limit: MAX_LISTED_SESSIONS,
    });
    return Promise.all(
      stored
        .filter((item) => !filter || scopeKey(storedRef(item)) === scopeKey(filter))
        .map((item) => {
          const root = roots.get(item.id);
          return root?.verified ? summary(root) : storedSummary(item);
        }),
    );
  }
  function trace(ctx: CliTrustedContext, sessionId: SessionId): TraceContext {
    return createRootTraceContext({
      traceId: (ctx.traceId ?? roots.get(ctx.rootSession.sessionId)!.app.traceId) as TraceId,
      sessionId,
    });
  }
  function remember<T>(
    ctx: CliTrustedContext,
    action: string,
    input: { requestId: string },
    run: () => Promise<T>,
  ): Promise<T> {
    const key = digest([ctx.callerId, ctx.rootSession, input.requestId]);
    const fingerprint = digest([action, input]);
    const previous = receipts.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new SessionControlError(
          "conflict",
          "requestId already belongs to a different request",
        );
      return previous.result as Promise<T>;
    }
    if (receipts.size >= maxRequests)
      throw new SessionControlError(
        "unavailable",
        "CLI request capacity reached; existing receipts remain queryable",
      );
    // 同步登记在调用任何异步工厂之前，重入与重试只能复用同一请求。
    const result = Promise.resolve().then(run);
    receipts.set(key, { fingerprint, result });
    pendingMutations.add(result);
    void result.then(
      () => pendingMutations.delete(result),
      () => pendingMutations.delete(result),
    );
    return result;
  }
  function commandId(ctx: CliTrustedContext, requestId: string): string {
    return `cli-control-${digest([ctx.callerId, ctx.rootSession, requestId])}`;
  }
  function attach(app: ZCodeApp, owned: boolean, verified = true): Root {
    if (roots.has(app.sessionId)) {
      const existing = roots.get(app.sessionId)!;
      if (existing.app !== app)
        throw new SessionControlError("conflict", "A different runtime already owns this session");
      return existing;
    }
    const root: Root = {
      app,
      owned,
      verified,
      prepared: false,
      signal: new AbortController(),
      completions: new Set(),
      unsubscribe: app.runtime.subscribeEvents({
        onSessionEvent: (event) => observations.onEvent(event),
      }),
    };
    roots.set(app.sessionId, root);
    return root;
  }
  function track(root: Root, completion: Promise<unknown>): void {
    root.completions.add(completion);
    void completion.then(
      () => root.completions.delete(completion),
      () => root.completions.delete(completion),
    );
  }
  // 本机会话库中的任意会话：只读持久事实，不恢复 runtime，也不认领 owner。
  function storedRef(stored: SessionInfo): CliSessionRef {
    return {
      kind: "cli",
      workspacePath: stored.directory,
      ...(stored.workspaceID ? { workspaceIdentity: stored.workspaceID } : {}),
      sessionId: stored.id,
    };
  }
  // 其他会话只有持久事实：状态未知，只宣称可读，不宣称可写。
  function storedSummary(stored: SessionInfo): SessionSummary<CliSessionRef> {
    return {
      session: storedRef(stored),
      title: stored.title,
      status: "unknown",
      availableActions: ["readSession"],
      updatedAt: new Date(stored.time.updated).toISOString(),
    };
  }
  async function readStored(sessionId: string): Promise<SessionInfo | undefined> {
    const stored = await options.sessionStore.getSession(sessionId as SessionId);
    return stored && !stored.time.deleted ? stored : undefined;
  }
  // 只返回 active 分支，并按产品界面同一判据去掉隐藏提醒，读取方看到的就是用户在界面里看到的对话。
  async function readVisibleMessages(stored: SessionInfo): Promise<MessageWithParts[]> {
    const messages = await options.sessionStore.messages({ sessionID: stored.id });
    const live = roots.get(stored.id);
    const rewindEvents = live
      ? (await live.app.runtime.getSessionEventStore().getEvents(stored.id)).filter(
          (event) => event.type === SessionEventType.RewindTriggered,
        )
      : [];
    return projectActiveSessionMessages(messages, stored, rewindEvents).filter(
      isTranscriptVisibleMessage,
    );
  }
  async function summary(root: Root): Promise<SessionSummary<CliSessionRef>> {
    const stored = await options.sessionStore.getSession(root.app.sessionId);
    if (stored?.time.deleted)
      throw new SessionControlError("unavailable", "Session has been deleted");
    const executionId = root.app.runtime.getActiveForegroundExecutionId();
    return {
      session: ref(root.app.sessionId),
      title: stored?.title ?? "New session",
      status:
        observations.statusForSession(root.app.sessionId) ??
        (root.app.runtime.hasActiveOrQueuedTurnWork() ? "running" : "idle"),
      availableActions: root.failure ? ["readSession"] : root.verified ? [...ROOT_ACTIONS] : [],
      ...(stored ? { updatedAt: new Date(stored.time.updated).toISOString() } : {}),
      ...(executionId ? { executionId } : {}),
    };
  }
  const methodContext: RuntimeMethodContext = {
    roots,
    workspace,
    options,
    observations,
    assertOpen,
    ref,
    owner,
    writable,
    reserveRoot,
    fence,
    validate,
    validateRead,
    listStored,
    trace,
    remember,
    commandId,
    attach,
    track,
    storedRef,
    storedSummary,
    readStored,
    readVisibleMessages,
    summary,
    releaseRootReservation() {
      rootReservations -= 1;
    },
    submit: (...args) => submitToCliRoot(methodContext, ...args),
  };
  const control = buildCliRuntimeControl(methodContext);

  async function closeRoot(root: Root): Promise<void> {
    if (!root.owned) return;
    root.app.runtime.beginShutdown();
    root.signal.abort(new Error(CLOSE_REASON));
    root.app.runtime.stopActiveForegroundExecution({ reason: CLOSE_REASON });
    // 一个清理步骤失败不能跳过 App 资源释放；所有失败由 close 汇总报告。
    const results = await Promise.allSettled([
      root.app.clearQueueItems(),
      root.app.runtime.cancelRunningRuntimeBackgroundTasks({ reason: "subagent_cancelled" }),
      Promise.allSettled(root.completions),
    ]);
    results.push(...(await Promise.allSettled([root.app.close?.()])));
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, "CLI root cleanup failed");
  }
  return {
    control,
    attachRoot(app, provenance) {
      assertOpen();
      const root = attach(app, false, provenance === "new-independent-root");
      // 新建主根首次活动由它自己的 App/TUI 驱动；一旦已有执行，后续用原 FIFO。
      root.prepared = app.runtime.hasActiveOrQueuedTurnWork();
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      // 先同步中断，避免等待在途 admission 时错过退出；晚到新 app 由创建路径立即关闭。
      for (const root of roots.values())
        if (root.owned) {
          root.app.runtime.beginShutdown();
          root.signal.abort(new Error(CLOSE_REASON));
          root.app.runtime.stopActiveForegroundExecution({ reason: CLOSE_REASON });
        }
      closePromise = (async () => {
        await Promise.allSettled(pendingMutations);
        const results = await Promise.allSettled([...roots.values()].map(closeRoot));
        observations.close();
        for (const root of roots.values()) root.unsubscribe();
        const errors = results
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map((result) => result.reason);
        if (errors.length) throw new AggregateError(errors, "CLI roots could not close cleanly");
      })();
      return closePromise;
    },
  };
}
