import { WebSocket, type RawData } from "ws";
import {
  ChannelClient,
  Emitter,
  ProxyChannel,
  SocketProtocol,
  VSBuffer,
  type ISocket,
} from "@zcode/rpc";
import { ISourceWorkspaceInspectionService } from "@zcode/services/source-server-workspace";
import { RemoteServiceAccess } from "@zcode/client";
import {
  serverRemoteHostCapabilitySchema,
  serverRemoteInfoSchema,
  type ServerRemoteInfo,
} from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import type { SourceServerTransport } from "@zcode/server/source-server";
import {
  createSourceHttpAgent,
  openSourceWebSocket,
  requestSourceJson,
} from "./sourceServerDuplexTransport.js";

export interface SourceServerRpcConnection {
  serverInfo: ServerRemoteInfo;
  services: IServiceAccessor;
  workspaceInspection?: ISourceWorkspaceInspectionService;
  readonly isClosed: boolean;
  onDidClose(listener: () => void): { dispose(): void };
  dispose(): void;
}
export async function connectSourceServerRpc(
  transport: SourceServerTransport,
  signal?: AbortSignal,
): Promise<SourceServerRpcConnection> {
  const agent = await createSourceHttpAgent(() => transport.openChannel());
  let client: ChannelClient | undefined;
  let protocol: SocketProtocol | undefined;
  let socket: WebSocket | undefined;
  const closes = new Emitter<void>();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    client?.dispose();
    protocol?.dispose();
    socket?.terminate();
    agent.destroy();
    closes.fire();
    closes.dispose();
  };
  try {
    const serverInfo = serverRemoteInfoSchema.parse(
      await requestSourceJson(agent, "/api/server-info", transport.ingressToken, "GET", signal),
    );
    if (!serverInfo.capabilities.sourceServer || !serverInfo.compatibility)
      throw new Error("Source Server capability is unavailable");
    const capability = serverRemoteHostCapabilitySchema.parse(
      await requestSourceJson(
        agent,
        "/api/rpc-host-capability",
        transport.ingressToken,
        "POST",
        signal,
      ),
    );
    socket = await openSourceWebSocket(
      agent,
      transport.ingressToken,
      capability.capability,
      (ws) => {
        const data = new Emitter<VSBuffer>();
        ws.on("message", (raw: RawData) =>
          data.fire(
            VSBuffer.wrap(
              Array.isArray(raw)
                ? Buffer.concat(raw)
                : Buffer.isBuffer(raw)
                  ? raw
                  : Buffer.from(raw),
            ),
          ),
        );
        ws.once("close", dispose);
        ws.once("error", dispose);
        const rpcSocket: ISocket = {
          onData: data.event,
          onClose: closes.event,
          onEnd: closes.event,
          write(buffer) {
            if (ws.readyState === WebSocket.OPEN) ws.send(buffer.buffer);
          },
          end() {
            ws.close();
          },
          drain: () => Promise.resolve(),
          dispose() {
            data.dispose();
            ws.close();
          },
        };
        // 首帧 Initialize 可以与 upgrade 同包到达，必须在 open Promise 返回前装上 RPC reader。
        protocol = new SocketProtocol(rpcSocket);
        client = new ChannelClient(protocol);
      },
      signal,
    );
    if (!client || disposed) throw new Error("Source closed before RPC was ready");
    const workspaceInspection = serverInfo.capabilities.sourceWorkspaceInspectionV1
      ? ProxyChannel.toService<ISourceWorkspaceInspectionService>(
          client.getChannel(ISourceWorkspaceInspectionService.channelName),
        )
      : undefined;
    return {
      serverInfo,
      services: new RemoteServiceAccess(client),
      ...(workspaceInspection ? { workspaceInspection } : {}),
      get isClosed() {
        return disposed;
      },
      onDidClose: closes.event,
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
