/* eslint-disable max-lines -- 移动端首页与会话共享连接态，避免拆分状态投影所有权。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MobileRemoteControlClient,
  readPairingParamsFromLocation,
  type MobileConnectionState,
} from "./protocol.js";
import {
  presentMobileConnection,
  type MobileConnectionSnapshot,
} from "./connectionPresentation.js";
import {
  createCommandEnvelope,
  pendingCommandRegistry,
  type ConversationStoreState,
  type ConversationTransport,
} from "@zcode/ui/conversation-client";
import type { CommandEnvelope, ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { submissionModeSchema } from "@zcode/shared/zcode-protocol-v4";
import { TaskConversationLifecycle } from "./taskConversationLifecycle.js";
import { logger } from "../../../ui/src/logger.js";
import type {
  WebRemoteControlBootstrapResult,
  WebRemoteControlAppPayload,
  WebRemoteControlTaskRef,
  WebRemoteControlWorkspaceRef,
} from "@zcode/shared";

/** 手机复用已有 Host 的 replayable V4 会话投影，不另建运行时或已接受输入队列。 */
interface PendingSubmission {
  scope: string;
  accessKey: string;
  revision: number;
  text: string;
  envelope: CommandEnvelope;
}

interface DraftEntry {
  scope: string;
  text: string;
  revision: number;
}

function hasSubmittedInput(snapshot: ConversationSnapshot, commandId: string): boolean {
  return (
    snapshot.queue.items.some((item) => item.sourceCommandId === commandId) ||
    snapshot.rows.window.some(
      (row) => row.kind === "userInput" && row.sourceCommandId === commandId,
    )
  );
}

type View = { kind: "home" } | { kind: "task"; task: WebRemoteControlTaskRef };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function findWorkspace(
  bootstrap: WebRemoteControlBootstrapResult | null,
  workspaceKey: string,
): WebRemoteControlWorkspaceRef | undefined {
  return bootstrap?.workspaces.find((item) => item.workspaceKey === workspaceKey);
}

export function MobileApp() {
  const [params, setParams] = useState<ReturnType<typeof readPairingParamsFromLocation> | null>(
    null,
  );
  const [paramsError, setParamsError] = useState<string | null>(null);
  const clientRef = useRef<MobileRemoteControlClient | null>(null);
  const [connectionSnapshot, setConnectionSnapshot] = useState<MobileConnectionSnapshot>({
    state: "connecting",
  });
  const connection = connectionSnapshot.state;
  const [bootstrap, setBootstrap] = useState<WebRemoteControlBootstrapResult | null>(null);
  const [view, setView] = useState<View>({ kind: "home" });
  const [organize, setOrganize] = useState<"timeline" | "workspace">("timeline");
  const [sortBy, setSortBy] = useState<"created" | "updated">("updated");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [conversationView, setConversationView] = useState<{
    scope: string;
    accessKey: string;
    state: ConversationStoreState;
  } | null>(null);
  const lifecycleRef = useRef<TaskConversationLifecycle | null>(null);
  const lifecycleAccessRef = useRef<string | null>(null);
  // 单槽会被另一个任务的编辑/发送覆盖；按完整目标保存草稿与原 commandId 对账线索。
  const [drafts, setDrafts] = useState<Map<string, DraftEntry>>(() => new Map());
  const draftRevision = useRef(0);
  const pendingSubmissions = useRef(new Map<string, PendingSubmission>());
  // 门禁属于具体提交，旧 ACK/查询只能释放自己的门禁，不能解开更新提交。
  const inFlightSubmission = useRef<PendingSubmission | null>(null);
  const [sending, setSending] = useState(false);
  const currentScope =
    view.kind === "task" ? JSON.stringify([view.task.workspaceKey, view.task.taskId]) : "home";
  const scopeRef = useRef(currentScope);
  scopeRef.current = currentScope;
  const [notice, setNotice] = useState<string | null>(null);
  // 传输降级回调由「订阅 effect」注册：`onPayload` 在 client 构造时绑定，
  // 之后通过 ref 把 bridge-degraded 路由到当前 task 的完整桥恢复。
  const onTransportDegradedRef = useRef<() => void>(() => {});

  const reportError = useCallback((message: string, error: unknown) => {
    logger.error(message, error);
    setNotice(describeError(error));
  }, []);

  useEffect(() => {
    try {
      setParams(readPairingParamsFromLocation());
    } catch (error) {
      setParamsError(describeError(error));
    }
  }, []);

  const refreshBootstrap = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    const response = await client.request({
      zcode_type: "bootstrap-request",
      requestId: `bootstrap-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });
    if (response.zcode_type === "bootstrap-response") setBootstrap(response.result);
  }, []);

  useEffect(() => {
    if (!params) return;
    const client = new MobileRemoteControlClient(params, {
      onStateChange: (state, detail) => setConnectionSnapshot({ state, detail }),
      onPayload: (payload) => {
        if (payload.zcode_type === "workspace-list-updated") {
          setBootstrap((current) =>
            current
              ? {
                  ...current,
                  workspaces: payload.result.workspaces,
                  tasks: payload.result.tasks,
                }
              : current,
          );
        }
        if (payload.zcode_type === "bridge-degraded") onTransportDegradedRef.current();
        if (payload.zcode_type === "app-error") setNotice(payload.error ?? payload.reason);
      },
    });
    clientRef.current = client;
    client.connect();
    return () => {
      client.dispose();
      clientRef.current = null;
    };
  }, [params]);

  // 网络恢复 / 页面回到前台时立刻补一次重连；其余情况交给客户端内部的退避重连。
  useEffect(() => {
    const onOnline = () => clientRef.current?.retryNow();
    const onVisible = () => {
      if (document.visibilityState === "visible") clientRef.current?.retryNow();
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    // 重连时清单可能已变化；不能因为保留了上次 bootstrap 就跳过刷新。
    if (connection !== "paired") return;
    void refreshBootstrap().catch((error) => reportError("[mobile] bootstrap 拉取失败", error));
  }, [connection, refreshBootstrap, reportError]);

  const selectedTaskId = view.kind === "task" ? view.task.taskId : undefined;
  const selectedWorkspaceKey = view.kind === "task" ? view.task.workspaceKey : undefined;
  const selectedWorkspace = selectedWorkspaceKey
    ? findWorkspace(bootstrap, selectedWorkspaceKey)
    : undefined;
  const selectedWorkspacePath = selectedWorkspace?.workspacePath;
  const selectedWorkspaceIdentity = selectedWorkspace?.workspaceIdentity;
  const selectedRemoteSessionId = selectedWorkspace?.remoteSessionId;
  const accessKey = JSON.stringify([
    selectedWorkspaceKey,
    selectedTaskId,
    selectedWorkspacePath,
    selectedWorkspaceIdentity,
    selectedRemoteSessionId,
  ]);
  const draftState = drafts.get(accessKey);
  const draft = draftState?.scope === currentScope ? draftState.text : "";
  const conversation =
    conversationView?.scope === currentScope && conversationView.accessKey === accessKey
      ? conversationView.state
      : null;

  const confirmSubmission = useCallback((pending: PendingSubmission) => {
    if (pendingSubmissions.current.get(pending.accessKey) !== pending) return;
    pendingSubmissions.current.delete(pending.accessKey);
    if (inFlightSubmission.current === pending) {
      inFlightSubmission.current = null;
      setSending(false);
    }
    if (scopeRef.current === pending.scope && lifecycleAccessRef.current === pending.accessKey) {
      setNotice(null);
    }
    // ACK 可在离开任务后到达；按草稿自己的完整目标与版本清除，避免返回后重复发送已接受输入。
    const revision = ++draftRevision.current;
    setDrafts((previous) => {
      const current = previous.get(pending.accessKey);
      if (current?.scope !== pending.scope || current.revision !== pending.revision)
        return previous;
      const next = new Map(previous);
      next.set(pending.accessKey, { ...current, text: "", revision });
      return next;
    });
  }, []);

  const reconcileSubmission = useCallback(
    async (transport: ConversationTransport, scope: string, targetKey: string) => {
      const pending = pendingSubmissions.current.get(targetKey);
      if (
        !pending ||
        pending.scope !== scope ||
        pending.accessKey !== targetKey ||
        inFlightSubmission.current
      )
        return;
      const result = await transport.queryCommands({
        commands: [
          {
            sessionId: pending.envelope.sessionId,
            commandId: pending.envelope.commandId,
          },
        ],
      });
      const ack = result.results.find(
        (item) =>
          item.key.sessionId === pending.envelope.sessionId &&
          item.key.commandId === pending.envelope.commandId,
      )?.result;
      // 查询可比手动重试更晚返回，不能用旧查询的拒绝结果清掉新一轮提交或改写其提示。
      if (pendingSubmissions.current.get(targetKey) !== pending) return;
      pendingCommandRegistry.applyQuery(result);
      if (!ack || ack === "unknown") return;
      if (ack.status === "failed" && ack.reasonCode === "fault.command.queryUnavailable") {
        // 查询暂不可用不是命令拒绝；保留原 envelope，等用户手动重试时复用 commandId。
        if (scopeRef.current === scope && lifecycleAccessRef.current === pending.accessKey) {
          setNotice("发送结果待确认，草稿已保留。点击发送可使用原提交重试。");
        }
        return;
      }
      if (ack.status === "accepted" || ack.status === "duplicate") {
        if (scopeRef.current === scope && lifecycleAccessRef.current === pending.accessKey) {
          lifecycleRef.current?.store?.expectAcceptedInputProjection(pending.envelope.commandId);
        }
        confirmSubmission(pending);
      } else if (pendingSubmissions.current.get(targetKey) === pending) {
        if (scopeRef.current === scope && lifecycleAccessRef.current === pending.accessKey) {
          lifecycleRef.current?.store?.settleCommand(pending.envelope.commandId);
        }
        pendingSubmissions.current.delete(targetKey);
        if (scopeRef.current === scope && lifecycleAccessRef.current === pending.accessKey) {
          const message = ack.message?.trim();
          setNotice(
            message && !message.startsWith("fault.")
              ? `${message}，草稿已保留`
              : "消息未发送，草稿已保留",
          );
        }
      }
    },
    [confirmSubmission],
  );

  useEffect(() => {
    if (
      !selectedTaskId ||
      !selectedWorkspaceKey ||
      !selectedWorkspacePath ||
      connection !== "paired"
    ) {
      setConversationView((previous) =>
        previous
          ? {
              ...previous,
              state: { ...previous.state, status: "connecting" },
            }
          : null,
      );
      return;
    }
    const client = clientRef.current;
    if (!client) return;
    const scope = JSON.stringify([selectedWorkspaceKey, selectedTaskId]);
    const access = {
      workspaceKey: selectedWorkspaceKey,
      taskId: selectedTaskId,
      workspacePath: selectedWorkspacePath,
      workspaceIdentity: selectedWorkspaceIdentity,
      remoteSessionId: selectedRemoteSessionId,
    };
    let wasReady = false;
    const lifecycle = new TaskConversationLifecycle(access, {
      prepare: () => client.prepareTask(access),
      open: () => client.openTaskConversation(access),
      onState: (state) => {
        // Socket 重连会重建 lifecycle；保留同目标旧正文用于阅读，首帧前仍禁发，不把旧水位喂回 store。
        setConversationView((previous) => ({
          scope,
          accessKey,
          state:
            !state.snapshot && previous?.accessKey === accessKey
              ? {
                  ...state,
                  status: state.status === "live" ? "connecting" : state.status,
                  snapshot: previous.state.snapshot,
                }
              : state,
        }));
        if (state.snapshot) {
          pendingCommandRegistry.reconcileSnapshot(state.snapshot);
          const pending = pendingSubmissions.current.get(accessKey);
          if (
            pending?.scope === scope &&
            hasSubmittedInput(state.snapshot, pending.envelope.commandId)
          ) {
            confirmSubmission(pending);
          }
        }
        const ready = state.status === "live" && state.snapshot !== null;
        if (ready && !wasReady) {
          setNotice(null);
          if (lifecycle.transport) {
            void reconcileSubmission(lifecycle.transport, scope, accessKey).catch(() => {});
          }
        }
        wasReady = ready;
      },
      onError: (error) => reportError("[mobile] 会话同步失败", error),
    });
    lifecycleRef.current = lifecycle;
    lifecycleAccessRef.current = accessKey;
    onTransportDegradedRef.current = () => lifecycle.recoverBridge();
    lifecycle.start();
    return () => {
      lifecycle.dispose();
      if (lifecycleRef.current === lifecycle) {
        lifecycleRef.current = null;
        lifecycleAccessRef.current = null;
      }
      onTransportDegradedRef.current = () => {};
    };
  }, [
    selectedTaskId,
    selectedWorkspaceKey,
    selectedWorkspacePath,
    selectedWorkspaceIdentity,
    selectedRemoteSessionId,
    connection,
    reportError,
    confirmSubmission,
    reconcileSubmission,
    accessKey,
  ]);

  const sendPrompt = useCallback(async () => {
    const lifecycle = lifecycleRef.current;
    const state = lifecycle?.store?.getState();
    const transport = lifecycle?.transport;
    const content = draft.trim();
    if (
      connection !== "paired" ||
      lifecycleAccessRef.current !== accessKey ||
      !transport ||
      state?.status !== "live" ||
      !state.snapshot ||
      view.kind !== "task" ||
      !content ||
      inFlightSubmission.current
    )
      return;
    const scope = JSON.stringify([view.task.workspaceKey, view.task.taskId]);
    const prior = pendingSubmissions.current.get(accessKey);
    const revision = draftState?.revision ?? 0;
    // ACK 丢失后手动重试沿用 commandId，由 CommandInbox 幂等裁决，绝不自动重放。
    const pending =
      prior?.scope === scope && prior.text === content
        ? { ...prior, revision }
        : {
            scope,
            accessKey,
            revision,
            text: content,
            envelope: createCommandEnvelope({
              type: "sendText",
              sessionId: view.task.taskId,
              payload: {
                text: content,
                modelSelection: state.snapshot.config.modelSelection,
                mode: submissionModeSchema.safeParse(state.snapshot.config.mode).data,
                planEnabled: state.snapshot.config.planEnabled,
              },
            }),
          };
    pendingSubmissions.current.set(accessKey, pending);
    inFlightSubmission.current = pending;
    setNotice(null);
    pendingCommandRegistry.record(pending.envelope, {
      workspace: {
        workspacePath: selectedWorkspacePath ?? "",
        workspaceIdentity: selectedWorkspaceIdentity,
      },
    });
    setSending(true);
    lifecycle.store?.markCommandPending({
      commandId: pending.envelope.commandId,
      type: "sendText",
      issuedAt: pending.envelope.issuedAt,
    });
    let shouldReconcile = false;
    try {
      const ack = await transport.sendCommand(pending.envelope);
      if (pendingSubmissions.current.get(accessKey) !== pending) return;
      pendingCommandRegistry.applyAck(pending.envelope, ack);
      if (ack.status === "accepted" || ack.status === "duplicate") {
        lifecycle.store?.expectAcceptedInputProjection(pending.envelope.commandId);
        confirmSubmission(pending);
      } else {
        lifecycle.store?.settleCommand(pending.envelope.commandId);
        if (pendingSubmissions.current.get(accessKey) !== pending) return;
        pendingSubmissions.current.delete(accessKey);
        if (scopeRef.current === scope && lifecycleAccessRef.current === pending.accessKey)
          setNotice(ack.message ?? "消息未发送，草稿已保留");
      }
    } catch (error) {
      if (pendingSubmissions.current.get(accessKey) !== pending) return;
      if (scopeRef.current === scope && lifecycleAccessRef.current === pending.accessKey)
        reportError("[mobile] 发送消息失败，草稿已保留", error);
      shouldReconcile = true;
    } finally {
      if (inFlightSubmission.current === pending) {
        inFlightSubmission.current = null;
        setSending(false);
        if (shouldReconcile) {
          const current = lifecycleRef.current;
          if (
            lifecycleAccessRef.current === pending.accessKey &&
            current?.transport &&
            current.store?.getState().snapshot
          ) {
            void reconcileSubmission(current.transport, scope, pending.accessKey).catch(() => {});
          }
        }
      }
    }
  }, [
    draft,
    draftState?.revision,
    view,
    connection,
    accessKey,
    selectedWorkspacePath,
    selectedWorkspaceIdentity,
    reportError,
    confirmSubmission,
    reconcileSubmission,
  ]);

  const messages = useMemo(
    () =>
      (conversation?.snapshot?.rows.window ?? []).flatMap((row) =>
        row.kind === "userInput" || row.kind === "assistantText"
          ? [
              {
                id: String(row.rowId),
                role: row.kind === "userInput" ? "user" : "assistant",
                text: row.text,
              },
            ]
          : [],
      ),
    [conversation?.snapshot],
  );
  const conversationReady =
    connection === "paired" &&
    conversation?.status === "live" &&
    conversation.snapshot !== null &&
    conversationView?.accessKey === accessKey;
  // 发送确认在途只限制再次发送；只读历史分页仍可复用已就绪的会话。
  const canSend = conversationReady && !inFlightSubmission.current;

  const groupedWorkspaces = useMemo(() => {
    const workspaces = bootstrap?.workspaces ?? [];
    const tasks = bootstrap?.tasks ?? [];
    const sorted = [...tasks].sort((a, b) => {
      if (sortBy === "updated") return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
      return (b.createdAt ?? 0) - (a.createdAt ?? 0);
    });
    if (organize === "timeline") return [{ key: "timeline", label: null, tasks: sorted }];
    return workspaces.map((workspace) => ({
      key: workspace.workspaceKey,
      label: workspace.label ?? workspace.workspacePath,
      tasks: sorted.filter((task) => task.workspaceKey === workspace.workspaceKey),
    }));
  }, [bootstrap, organize, sortBy]);

  if (paramsError) {
    return (
      <Shell notice={paramsError}>
        <p className="text-ui-base text-foreground-subtle">
          远程控制链接无效，请回到桌面端重新生成二维码。
        </p>
      </Shell>
    );
  }

  // React 会复用同位置的 Shell；按视图 scope 换 key，避免首页与会话继承彼此的滚动偏移。
  if (view.kind === "task") {
    return (
      <Shell
        key={JSON.stringify([view.task.workspaceKey, view.task.taskId])}
        connection={connection}
        connectionDetail={connectionSnapshot.detail}
        title={`任务会话`}
        onBack={() => setView({ kind: "home" })}
        onRefresh={() => lifecycleRef.current?.recoverBridge()}
        notice={notice}
        composer={
          <div className="flex min-w-0 gap-2">
            <input
              value={draft}
              onChange={(event) => {
                const revision = ++draftRevision.current;
                setDrafts((previous) => {
                  const next = new Map(previous);
                  next.set(accessKey, {
                    scope: currentScope,
                    text: event.target.value,
                    revision,
                  });
                  return next;
                });
              }}
              placeholder="发送消息"
              className="h-10 min-w-0 flex-1 rounded-lg border border-input-border bg-surface px-3 text-mobile-input-safe text-foreground"
            />
            <button
              type="button"
              className="h-10 shrink-0 rounded-lg bg-primary px-4 text-ui-base font-medium text-primary-foreground disabled:opacity-50"
              disabled={!draft.trim() || !canSend}
              onClick={() => void sendPrompt()}
            >
              {sending ? "确认中" : "发送"}
            </button>
          </div>
        }
      >
        <div className="flex min-w-0 flex-col gap-3">
          {conversation?.snapshot &&
          conversation.snapshot.rows.firstRowId !== null &&
          (conversation.snapshot.rows.window[0]?.rowId ?? 0) >
            conversation.snapshot.rows.firstRowId ? (
            <button
              type="button"
              className="self-center text-ui-caption text-primary disabled:opacity-50"
              disabled={!conversationReady || conversation.loadingOlder}
              onClick={() => void lifecycleRef.current?.store?.loadOlder()}
            >
              {conversation.loadingOlder ? "正在加载…" : "加载更早消息"}
            </button>
          ) : null}
          {messages.map((message) => (
            <div
              key={message.id}
              className={
                message.role === "user"
                  ? "min-w-0 max-w-[85%] self-end whitespace-pre-wrap rounded-2xl bg-primary px-3 py-2 text-ui-base text-primary-foreground [overflow-wrap:anywhere]"
                  : "min-w-0 max-w-[85%] self-start whitespace-pre-wrap rounded-2xl bg-surface px-3 py-2 text-ui-base text-foreground [overflow-wrap:anywhere]"
              }
            >
              {message.text}
            </div>
          ))}
          {conversation?.status === "connecting" && conversation.snapshot ? (
            <p role="status" className="text-center text-ui-caption text-foreground-subtle">
              正在同步会话…
            </p>
          ) : null}
          {conversation?.snapshot?.queue.items.map((item) => (
            <div
              key={item.queueItemId}
              className="min-w-0 max-w-[85%] self-end whitespace-pre-wrap rounded-2xl border border-input-border px-3 py-2 text-ui-base text-foreground [overflow-wrap:anywhere]"
            >
              <span className="text-ui-caption text-foreground-subtle">排队中</span>
              <p>{item.text}</p>
            </div>
          ))}
          {messages.length === 0 && !conversation?.snapshot?.queue.items.length ? (
            <p className="text-center text-ui-base text-foreground-subtle">
              {conversation?.snapshot ? "暂无消息" : "正在同步会话…"}
            </p>
          ) : null}
        </div>
      </Shell>
    );
  }

  return (
    <Shell
      key="home"
      connection={connection}
      connectionDetail={connectionSnapshot.detail}
      onRefresh={() =>
        void refreshBootstrap().catch((error) => reportError("[mobile] 刷新工作区失败", error))
      }
      notice={notice}
    >
      <section className="space-y-1">
        <h1 className="text-ui-lg font-medium text-foreground">ZCode 远程控制</h1>
        <p className="text-ui-base/relaxed text-foreground-subtle">
          本次连接可以查看当前设备上已打开的项目、任务和会话；二维码失效后需要回到桌面端重新连接。
        </p>
      </section>
      <section className="flex flex-wrap items-center gap-2">
        <span
          className={
            connection === "paired"
              ? "inline-flex h-6 items-center rounded-full border border-border px-2 text-ui-xs font-medium text-foreground"
              : "inline-flex h-6 items-center rounded-full border border-border px-2 text-ui-xs font-medium text-foreground-subtle"
          }
        >
          {presentMobileConnection(connection, connectionSnapshot.detail).label}
        </span>
        <span className="text-ui-xs text-foreground-subtle">
          {bootstrap?.workspaces.length ?? 0} 个工作区 · {bootstrap?.tasks.length ?? 0} 个任务
        </span>
      </section>
      <section className="flex flex-wrap gap-2">
        <button
          type="button"
          className="h-8 rounded-lg border border-border px-3 text-ui-xs text-foreground"
          onClick={() =>
            setOrganize((current) => (current === "timeline" ? "workspace" : "timeline"))
          }
        >
          整理任务：{organize === "timeline" ? "按时间线" : "按工作区"}
        </button>
        <button
          type="button"
          className="h-8 rounded-lg border border-border px-3 text-ui-xs text-foreground"
          onClick={() => setSortBy((current) => (current === "updated" ? "created" : "updated"))}
        >
          排序：{sortBy === "updated" ? "更新时间" : "创建时间"}
        </button>
        <button
          type="button"
          className="h-8 rounded-lg border border-border px-3 text-ui-xs text-foreground"
          onClick={() =>
            setCollapsed(
              collapsed.size > 0 ? new Set() : new Set(groupedWorkspaces.map((group) => group.key)),
            )
          }
        >
          {collapsed.size > 0 ? "展开全部" : "收起全部"}
        </button>
      </section>
      <section className="space-y-4">
        {groupedWorkspaces.map((group) => (
          <div key={group.key} className="space-y-2">
            {group.label ? (
              <h2 className="text-ui-base font-medium text-foreground">{group.label}</h2>
            ) : null}
            {collapsed.has(group.key) ? null : group.tasks.length === 0 ? (
              <p className="text-ui-base text-foreground-subtle">这个工作区暂无任务</p>
            ) : (
              <ul className="space-y-2">
                {group.tasks.map((task) => (
                  <li key={task.taskId}>
                    <button
                      type="button"
                      className="w-full rounded-xl border border-border bg-card p-3 text-left"
                      onClick={() => setView({ kind: "task", task })}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground">
                          {task.title}
                        </span>
                        <span className="shrink-0 text-ui-xs text-foreground-subtle">
                          {taskStatusLabel(task.displayStatus)}
                        </span>
                      </div>
                      {typeof task.updatedAt === "number" ? (
                        <div className="mt-1 text-ui-xs text-foreground-subtle">
                          更新于 {new Date(task.updatedAt).toLocaleString()}
                        </div>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </section>
    </Shell>
  );
}

function taskStatusLabel(status: WebRemoteControlTaskRef["displayStatus"]): string {
  switch (status) {
    case "running":
      return "运行中";
    case "completed":
      return "已完成";
    case "error":
      return "错误";
    default:
      return "空闲";
  }
}

function Shell(props: {
  connection?: MobileConnectionState;
  connectionDetail?: MobileConnectionSnapshot["detail"];
  title?: string;
  notice?: string | null;
  onBack?: () => void;
  onRefresh?: () => void;
  composer?: React.ReactNode;
  children: React.ReactNode;
}) {
  const connectionPresentation = props.connection
    ? presentMobileConnection(props.connection, props.connectionDetail)
    : null;
  return (
    // 原先只有 min-height，body 又被共享样式禁滚动，长列表/会话会越过视口且无法触摸下滑。
    // Shell 约束高度，main 唯一滚动；输入栏参与布局，避免 fixed 遮住正文。
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background pt-[env(safe-area-inset-top)] text-foreground">
      <header className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2">
        {props.onBack ? (
          <button type="button" className="text-ui-base text-primary" onClick={props.onBack}>
            返回任务首页
          </button>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-ui-base font-medium">
          {props.title ?? "ZCode 远程控制"}
        </span>
        {props.onRefresh ? (
          <button type="button" className="text-ui-xs text-primary" onClick={props.onRefresh}>
            刷新
          </button>
        ) : null}
      </header>
      {connectionPresentation && props.connection !== "paired" ? (
        <div
          className={`shrink-0 px-3 py-1 text-center text-ui-xs ${connectionPresentation.terminal ? "text-destructive" : "text-foreground-subtle"}`}
          role="status"
        >
          <p className="font-medium">{connectionPresentation.label}</p>
          <p>{connectionPresentation.description}</p>
        </div>
      ) : null}
      {props.notice ? (
        <p className="shrink-0 px-3 py-1 text-center text-ui-xs text-destructive">{props.notice}</p>
      ) : null}
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-3">
        <div className="flex min-w-0 flex-col gap-4">{props.children}</div>
      </main>
      {props.composer ? (
        <footer className="shrink-0 border-t border-border bg-card p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {props.composer}
        </footer>
      ) : null}
    </div>
  );
}

export type { WebRemoteControlAppPayload, WebRemoteControlWorkspaceRef };
