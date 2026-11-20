import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { SessionControlError, type CliScope } from "@zcode/session-control/contracts";
import type { ZCodeApp } from "../app/types.js";

const DEFAULT_PAGE_SIZE = 50;

// 读本机会话库的列表只扫描有界窗口，避免一次把全部历史会话行解码进内存。
const MAX_LISTED_SESSIONS = 2000;

const DEFAULT_MAX_REQUESTS = 4096;

const DEFAULT_MAX_ROOTS = 128;

const CLOSE_REASON = "CLI session control owner closed";

const NO_OWNER =
  "No reachable independent CLI owner is registered for this session; history will not be restored";

const ROOT_ACTIONS = [
  "readSession",
  "sendToSession",
  "waitSessions",
  "interruptSession",
  "renameSession",
  "forkSession",
] as const;

type Root = {
  app: ZCodeApp;
  owned: boolean;
  verified: boolean;
  signal: AbortController;
  unsubscribe: () => void;
  completions: Set<Promise<unknown>>;
  prepared: boolean;
  failure?: string;
  preparation?: Promise<void>;
};

type RequestReceipt = { fingerprint: string; result: Promise<unknown> };

function scopeKey(scope: CliScope): string {
  return scope.workspaceIdentity?.trim() || resolve(scope.workspacePath);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function pageOffset(cursor?: string): number {
  if (cursor === undefined) return 0;
  if (!/^offset:(0|[1-9][0-9]*)$/.test(cursor))
    throw new SessionControlError("invalid_input", "Invalid page cursor");
  const offset = Number(cursor.slice("offset:".length));
  if (!Number.isSafeInteger(offset))
    throw new SessionControlError("invalid_input", "Invalid page cursor");
  return offset;
}

function page<T>(
  items: T[],
  cursor?: string,
  limit = DEFAULT_PAGE_SIZE,
): { items: T[]; nextCursor?: string } {
  const offset = pageOffset(cursor);
  return {
    items: items.slice(offset, offset + limit),
    ...(offset + limit < items.length ? { nextCursor: `offset:${offset + limit}` } : {}),
  };
}
export {
  DEFAULT_PAGE_SIZE,
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
  pageOffset,
  page,
};
