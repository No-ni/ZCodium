import type { ConnectionProfile } from "@zcode/shared";
import type {
  connectSourceServerTransport,
  executeSourceServerCommand,
  SourceServerTransport,
} from "@zcode/server/source-server";
import type { connectSourceServerRpc, SourceServerRpcConnection } from "./sourceServerRpc.js";
import type { SourceServerDirectory } from "./sourceServerDirectory.js";

export interface OnlineSource {
  generation: number;
  profile: ConnectionProfile;
  transport: SourceServerTransport;
  connection: SourceServerRpcConnection;
  references: number;
  closeSubscription?: { dispose(): void };
  disposal?: Promise<void>;
}

export interface Flight {
  profile: ConnectionProfile;
  controller: AbortController;
  promise: Promise<OnlineSource>;
  waiters: number;
  settled: boolean;
  expectedSourceServerId?: string;
}

export interface ManagedSourceHandle {
  sourceServerId: string;
  profile: ConnectionProfile;
  services: SourceServerRpcConnection["services"];
  workspaceInspection?: SourceServerRpcConnection["workspaceInspection"];
  backend: SourceServerTransport["backend"];
  onDidClose: SourceServerRpcConnection["onDidClose"];
  dispose(): Promise<void>;
}

export interface ManagerOptions {
  directory: SourceServerDirectory;
  connectTransport?: typeof connectSourceServerTransport;
  connectRpc?: typeof connectSourceServerRpc;
  beforePublish?: (source: OnlineSource) => Promise<void>;
  executeCommand?: typeof executeSourceServerCommand;
  beforeLifecycle?: (sourceServerId: string, signal: AbortSignal) => Promise<void>;
}
