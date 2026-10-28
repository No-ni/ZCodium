import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { DatabaseSync } from "node:sqlite";

const flights = new Map<string, Promise<unknown>>();
const memoryIdentities = new WeakMap<DatabaseSync, string>();
export const NATIVE_BUSY_TIMEOUT_MS = 25;
const DEFAULT_LOCK_WAIT_MS = 60 * 60_000;
const MAX_RETRY_DELAY_MS = 200;

export interface SqliteLockOptions {
  signal?: AbortSignal;
  lockWaitTimeoutMs?: number;
  onWaitingForLock?: () => void | Promise<void>;
}

export function databasePath(db: DatabaseSync): string {
  const path = db
    .prepare("PRAGMA database_list")
    .all()
    .find((row) => row.name === "main")?.file;
  return typeof path === "string" ? path : "";
}

export function assertMainDatabaseScope(db: DatabaseSync): void {
  // 历史 SQL 不全限定 main，TEMP 同名表或 ATTACH 会让写入偏离唯一备份/锁 owner；必须先拒绝。
  if (
    db
      .prepare("PRAGMA database_list")
      .all()
      .some((row) => row.name !== "main" && row.name !== "temp") ||
    db.prepare("SELECT 1 FROM temp.sqlite_schema LIMIT 1").get()
  )
    throw Object.assign(new Error("SQLite migration requires a dedicated main-only connection"), {
      kind: "schema_incompatible",
    });
}

async function databaseIdentity(db: DatabaseSync): Promise<string> {
  const path = databasePath(db);
  if (path) {
    const canonical = await realpath(resolve(path));
    return process.platform === "win32" ? canonical.toLowerCase() : canonical;
  }
  let identity = memoryIdentities.get(db);
  if (!identity) {
    identity = `memory:${randomUUID()}`;
    memoryIdentities.set(db, identity);
  }
  return identity;
}

export async function databasePathHash(db: DatabaseSync): Promise<string> {
  return createHash("sha256")
    .update(await databaseIdentity(db))
    .digest("hex");
}

export async function withMigrationAdmission<T>(
  db: DatabaseSync,
  operation: () => Promise<T>,
  options: { transactionOpen?: boolean; signal?: AbortSignal } = {},
): Promise<T> {
  options.signal?.throwIfAborted();
  const key = await databaseIdentity(db);
  const previous = flights.get(key);
  // 已持锁事务不能排在等待该锁的迁移后面，否则双方互等；未成功移交时保留调用方事务。
  if (options.transactionOpen && previous)
    throw new Error("Migration transaction admission conflict");
  const flight = Promise.resolve().then(async () => {
    if (previous) await waitForAdmission(previous, options.signal);
    options.signal?.throwIfAborted();
    return operation();
  });
  // 排队取消可立即返回，但必须保留先行 owner 的屏障；否则下一项会绕过仍运行的备份。
  const barrier = Promise.allSettled([...(previous ? [previous] : []), flight]).then(
    () => undefined,
  );
  flights.set(key, barrier);
  void barrier.then(() => {
    if (flights.get(key) === barrier) flights.delete(key);
  });
  return flight;
}

function waitForAdmission(previous: Promise<unknown>, signal?: AbortSignal): Promise<void> {
  if (!signal)
    return previous.then(
      () => undefined,
      () => undefined,
    );
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", aborted);
    const aborted = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener("abort", aborted, { once: true });
    void previous.then(
      () => {
        cleanup();
        resolve();
      },
      () => {
        cleanup();
        resolve();
      },
    );
    if (signal.aborted) aborted();
  });
}

export function isSqliteBusyError(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return typeof code === "number" && (code & 0xff) === 5;
}

export async function retrySqliteBusy<T>(
  operation: () => T,
  options: SqliteLockOptions = {},
): Promise<T> {
  const timeout = options.lockWaitTimeoutMs ?? DEFAULT_LOCK_WAIT_MS;
  if (!Number.isFinite(timeout) || timeout < 0) throw new Error("Invalid SQLite lock wait timeout");
  const deadline = Date.now() + timeout;
  let notified = false;
  let waitMs = 10;
  for (;;) {
    options.signal?.throwIfAborted();
    try {
      return operation();
    } catch (error) {
      // SQLITE_LOCKED 表示同连接/共享缓存冲突，不能冒充外部写锁等待。
      if (!isSqliteBusyError(error)) throw error;
      if (Date.now() >= deadline)
        throw Object.assign(new Error("SQLite migration lock wait expired", { cause: error }), {
          kind: "lock_timeout",
        });
      if (!notified) {
        notified = true;
        await options.onWaitingForLock?.();
      }
      options.signal?.throwIfAborted();
      await delay(Math.min(waitMs, Math.max(1, deadline - Date.now())), undefined, {
        signal: options.signal,
      });
      waitMs = Math.min(waitMs * 2, MAX_RETRY_DELAY_MS);
    }
  }
}

export async function acquireMigrationLock(
  db: DatabaseSync,
  options: SqliteLockOptions,
): Promise<void> {
  await retrySqliteBusy(() => db.exec("BEGIN IMMEDIATE"), options);
}

export function withShortBusyTimeout<T>(db: DatabaseSync, operation: () => Promise<T>): Promise<T> {
  return withConnectionPragma(db, "busy_timeout", NATIVE_BUSY_TIMEOUT_MS, operation);
}

export function withForeignKeysDisabled<T>(
  db: DatabaseSync,
  operation: () => Promise<T>,
): Promise<T> {
  return withConnectionPragma(db, "foreign_keys", 0, operation);
}

async function withConnectionPragma<T>(
  db: DatabaseSync,
  name: "busy_timeout" | "foreign_keys",
  value: number,
  operation: () => Promise<T>,
): Promise<T> {
  const row = db.prepare(`PRAGMA ${name}`).get();
  const previous = Number(row?.[name === "busy_timeout" ? "timeout" : name] ?? 0);
  let failed = false;
  let failure: unknown;
  let result!: T;
  db.exec(`PRAGMA ${name}=${value}`);
  try {
    result = await operation();
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    db.exec(`PRAGMA ${name}=${previous}`);
  } catch (error) {
    // 连接关闭等清理错误不能覆盖真正的迁移首因；不在 finally 中抛错。
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
  if (failed) throw failure;
  return result;
}
