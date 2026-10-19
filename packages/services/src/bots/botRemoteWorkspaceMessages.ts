import {
  HostMessageTypes,
  hostBotRemoteWorkspaceConnectionStatusResultMessageSchema,
  hostBotRemoteWorkspaceRuntimePortMessageSchema,
  hostBotRemoteWorkspaceReconnectResultMessageSchema,
} from "@zcode/shared";

export interface BotParentPortMessage {
  data: unknown;
  ports?: unknown[];
}

export interface BotParentPort {
  postMessage(message: unknown, transfer?: unknown[]): void;
  on(event: "message", listener: (event: BotParentPortMessage) => void): void;
}

type Consumer = (event: BotParentPortMessage) => boolean;
const consumersByPort = new WeakMap<BotParentPort, Set<Consumer>>();

export function closeBotRuntimePort(port: unknown): void {
  try {
    (port as { close?: () => void } | undefined)?.close?.();
  } catch {
    /* 端口已转移或已关闭也不能阻断其他端口的回收。 */
  }
}

function getConsumers(port: BotParentPort): Set<Consumer> {
  let consumers = consumersByPort.get(port);
  if (!consumers) {
    consumers = new Set();
    consumersByPort.set(port, consumers);
    const active = consumers;
    // 传输仅保留一份分发器；Bridge 注销后仍须关闭迟到端口，但不能闭包保留已注销 Bridge。
    port.on("message", (event) => {
      for (const receive of active) if (receive(event)) return;
      if (
        (event.data as { type?: unknown } | null)?.type ===
        HostMessageTypes.BotRemoteWorkspaceRuntimePort
      )
        for (const transferred of event.ports ?? []) closeBotRuntimePort(transferred);
    });
  }
  return consumers;
}

function subscribeBotRemoteWorkspaceMessages(port: BotParentPort, consumer: Consumer) {
  // 固定监听器须在独立作用域创建；与 unsubscribe 共用闭包会让首个 consumer 在注销后仍被保留。
  const consumers = getConsumers(port);
  consumers.add(consumer);
  const active = consumers;
  return () => {
    active.delete(consumer);
  };
}

export function subscribeBotRemoteWorkspaceResponses(
  port: BotParentPort,
  responses: {
    pending: Map<string, (result: { ok: boolean; sessionId?: string; error?: string }) => void>;
    pendingConnectionStatus: Map<
      string,
      (result: { ok: boolean; connected?: boolean; error?: string }) => void
    >;
    pendingRuntimePorts: Map<
      string,
      (result: { ok: boolean; port?: unknown; error?: string }) => void
    >;
    receivedRuntimePorts: Set<unknown>;
  },
) {
  return subscribeBotRemoteWorkspaceMessages(port, (event) => {
    const result = hostBotRemoteWorkspaceReconnectResultMessageSchema.safeParse(event.data);
    if (result.success) {
      const { requestId, ok, sessionId, error } = result.data;
      const resolve = responses.pending.get(requestId);
      if (!resolve) return false;
      responses.pending.delete(requestId);
      resolve({ ok, sessionId, error });
      return true;
    }
    const status = hostBotRemoteWorkspaceConnectionStatusResultMessageSchema.safeParse(event.data);
    if (status.success) {
      const { requestId, ok, connected, error } = status.data;
      const resolve = responses.pendingConnectionStatus.get(requestId);
      if (!resolve) return false;
      responses.pendingConnectionStatus.delete(requestId);
      resolve({ ok, connected, error });
      return true;
    }
    const runtime = hostBotRemoteWorkspaceRuntimePortMessageSchema.safeParse(event.data);
    if (!runtime.success) return false;
    const { requestId, ok, error } = runtime.data;
    const resolve = responses.pendingRuntimePorts.get(requestId);
    if (!resolve) return false;
    responses.pendingRuntimePorts.delete(requestId);
    const received = event.ports?.[0];
    // 匹配成功即转交 Bridge 托管；不能让回包到 async continuation 间的关闭遗留端口。
    if (received) responses.receivedRuntimePorts.add(received);
    for (const extra of event.ports?.slice(1) ?? []) closeBotRuntimePort(extra);
    resolve({ ok, port: received, error });
    return true;
  });
}
