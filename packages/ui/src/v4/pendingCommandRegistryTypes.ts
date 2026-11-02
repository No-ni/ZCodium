import type { CommandsQueryParams, CommandsQueryResult } from "@zcode/shared/zcode-protocol-v4";
import type { PendingCommandClientContext } from "@/v4/pendingCommandWorkspace.js";
import type { PendingCommandReplay } from "@/v4/pendingCommandReplay.js";

// V4 已提交命令的 renderer 持久账本。
// 它只保存客户端恢复线索，不参与 conversation projection，也绝不能据此自动重放。

export type PendingCommandResolution =
  | "accepted"
  | "duplicate"
  | "authoritative"
  | "failed"
  | "discarded";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type PendingCommandRecoveryReason = "discarded";

export interface PendingCommandEntry {
  commandId: string;
  clientId: string;
  sessionId: string | null;
  issuedAt: number;
  expiresAt: number;
  replay: PendingCommandReplay;
  clientContext?: PendingCommandClientContext;
  recovery?: PendingCommandRecoveryReason;
  recoveryDismissed?: boolean;
}

export interface PendingCommandReplayRequest {
  type: "sendText" | "sendGoalCommand" | "compact" | "createSession";
  payload: Record<string, unknown>;
  sessionId: string | null;
  baseRevision?: number;
  clientContext?: PendingCommandClientContext;
}

export interface PendingCommandRegistryOptions {
  storage?: StorageLike;
  now?: () => number;
}

export type QueryCommands = (params: CommandsQueryParams) => Promise<CommandsQueryResult>;
