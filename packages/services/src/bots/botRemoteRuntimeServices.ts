import {
  ChannelClient,
  Emitter,
  MessagePortProtocol,
  ProxyChannel,
  type MessagePortLike,
  type MessagePortPayload,
  type Event,
} from "@zcode/rpc";
import {
  IZCodeTaskService,
  type IZCodeTaskService as IZCodeTaskServiceShape,
} from "#src/session/zcodeTaskService.js";
import {
  IZCodeAgentService,
  type IZCodeAgentService as IZCodeAgentServiceShape,
} from "#src/zcode-agent/zcodeAgent.js";
import {
  IZCodeSessionService,
  type IZCodeSessionService as IZCodeSessionServiceShape,
} from "#src/zcode-session/zcodeSession.js";
import {
  IModelSelectionService,
  type IModelSelectionService as IModelSelectionServiceShape,
} from "#src/model-provider/providerFacadeServices.js";

interface PortLike {
  on?(event: "message", listener: (event: { data: MessagePortPayload }) => void): void;
  off?(event: "message", listener: (event: { data: MessagePortPayload }) => void): void;
  addEventListener?(
    event: "message",
    listener: (event: { data: MessagePortPayload }) => void,
  ): void;
  removeEventListener?(
    event: "message",
    listener: (event: { data: MessagePortPayload }) => void,
  ): void;
  postMessage(message: MessagePortPayload): void;
  start?(): void;
  close?(): void;
}

function toMessagePortLike(port: PortLike): MessagePortLike {
  return {
    addEventListener(type, listener) {
      if (port.addEventListener) {
        port.addEventListener(type, listener);
        return;
      }
      port.on?.(type, listener);
    },
    removeEventListener(type, listener) {
      if (port.removeEventListener) {
        port.removeEventListener(type, listener);
        return;
      }
      port.off?.(type, listener);
    },
    postMessage(data) {
      port.postMessage(data);
    },
    start() {
      port.start?.();
    },
    close() {
      port.close?.();
    },
  };
}

export interface RemoteBotWorkspaceRuntimeServices {
  dispose(): void;
  readonly closed: boolean;
  readonly onDidClose: Event<void>;
  zcodeAgentService: IZCodeAgentServiceShape;
  zcodeTaskService: IZCodeTaskServiceShape;
  zcodeSessionService: IZCodeSessionServiceShape;
  modelSelectionService: IModelSelectionServiceShape;
}

export function createRemoteRuntimeServicesFromPort(
  port: unknown,
): RemoteBotWorkspaceRuntimeServices {
  const protocol = new MessagePortProtocol(toMessagePortLike(port as PortLike));
  const client = new ChannelClient(protocol);
  let disposed = false;
  const onDidClose = new Emitter<void>();
  const closeEvents = port as {
    on?(event: "close", listener: () => void): void;
    off?(event: "close", listener: () => void): void;
    addEventListener?(event: "close", listener: () => void): void;
    removeEventListener?(event: "close", listener: () => void): void;
  };
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (closeEvents.addEventListener) closeEvents.removeEventListener?.("close", dispose);
    else closeEvents.off?.("close", dispose);
    // 对端断开也要终结本地 RPC；随后通知 Bridge 按实例失效缓存，不能继续返回死连接。
    try {
      client.dispose();
      protocol.disconnect();
    } finally {
      onDidClose.fire();
      onDidClose.dispose();
    }
  }
  if (closeEvents.addEventListener) closeEvents.addEventListener("close", dispose);
  else closeEvents.on?.("close", dispose);
  return {
    dispose,
    get closed() {
      return disposed;
    },
    onDidClose: onDidClose.event,
    zcodeAgentService: ProxyChannel.toService<IZCodeAgentServiceShape>(
      client.getChannel(IZCodeAgentService.channelName),
    ),
    zcodeTaskService: ProxyChannel.toService<IZCodeTaskServiceShape>(
      client.getChannel(IZCodeTaskService.channelName),
    ),
    zcodeSessionService: ProxyChannel.toService<IZCodeSessionServiceShape>(
      client.getChannel(IZCodeSessionService.channelName),
    ),
    modelSelectionService: ProxyChannel.toService<IModelSelectionServiceShape>(
      client.getChannel(IModelSelectionService.channelName),
    ),
  };
}
