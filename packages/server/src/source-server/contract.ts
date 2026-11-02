import type { Duplex } from "node:stream";
import type { RemoteTarget } from "@zcode/shared";
import type { IRemoteBackend } from "@zcode/server/remote";
export interface SourceServerTransport {
  readonly ingressToken: string;
  readonly backend: IRemoteBackend;
  openChannel(): Promise<Duplex>;
  dispose(): Promise<void>;
}
export interface SourceServerTransportContract {
  connect(target: RemoteTarget, signal?: AbortSignal): Promise<SourceServerTransport>;
}
export type SourceServerCommand = "stop" | "restart" | "running-tasks";
export interface SourceServerCommandResult {
  readonly code: number;
  readonly stdout: string;
}
export interface SourceServerCommandOptions {
  signal?: AbortSignal;
  createBackend?: (target: RemoteTarget) => Promise<IRemoteBackend>;
}
export class SourceServerTransportError extends Error {
  constructor(
    readonly code:
      | "source-server-install-required"
      | "source-server-start-required"
      | "source-server-connection-failed",
  ) {
    super(code);
  }
}
