import type { DatabaseMigrationFacts } from "@zcode/shared";
import { retrySqliteBusy, withShortBusyTimeout } from "@zcode/shared/sqlite-migrations";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createRequire } from "node:module";
// 与既有 Repo 一致：避免构建器把 node:sqlite 改写成不存在的 npm sqlite 包。
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import { AutomationRepo } from "#src/session/automationRepo.js";
import {
  runTasksDatabaseMigrationsAsync,
  inspectTasksMigrationKind,
} from "#src/session/tasksDatabase/migrations.js";
import {
  markTasksStorageMigrated,
  markTasksStoragePrepared,
} from "#src/session/tasksDatabase/prepared.js";

type TasksStoragePhase =
  | "checking"
  | "waiting_for_lock"
  | "migrating"
  | "maintaining"
  | "committing"
  | "ready";
const LOCK_WAIT_MS = 60 * 60_000;
const BUSINESS_BUSY_TIMEOUT_MS = 5_000;

export interface TasksStorageStartupOptions {
  backupDirectories?: readonly string[];
  lockWaitTimeoutMs?: number;
  signal?: AbortSignal;
}

/** Host Worker 唯一启动 owner：runner 提交迁移后，才运行原有幂等投影维护。 */
export async function prepareTasksIndexStorage(
  path: string,
  onProgress: (phase: TasksStoragePhase, migration?: DatabaseMigrationFacts) => void,
  options: TasksStorageStartupOptions = {},
): Promise<void> {
  // 回调拿到的是当时事实，不共享后续执行会继续递增的内部对象。
  const report = (phase: TasksStoragePhase, migration?: DatabaseMigrationFacts) =>
    onProgress(phase, migration ? { ...migration } : undefined);
  options.signal?.throwIfAborted();
  report("checking");
  options.signal?.throwIfAborted();
  await mkdir(dirname(path), { recursive: true });
  options.signal?.throwIfAborted();
  const db = new DatabaseSync(path);
  let failed = false;
  let failure: unknown;
  let migration: DatabaseMigrationFacts | undefined;
  try {
    const deadline = Date.now() + (options.lockWaitTimeoutMs ?? LOCK_WAIT_MS);
    const waitOptions = () => ({
      signal: options.signal,
      lockWaitTimeoutMs: Math.max(0, deadline - Date.now()),
      onWaitingForLock: () => report("waiting_for_lock", migration),
    });
    await withShortBusyTimeout(db, async () => {
      db.exec("PRAGMA foreign_keys = ON");
      await retrySqliteBusy(() => {
        migration = { kind: inspectTasksMigrationKind(db), executedCount: 0, committedCount: 0 };
      }, waitOptions());
      report("checking", migration);
      await runTasksDatabaseMigrationsAsync(db, {
        ...waitOptions(),
        migration,
        backupDirectories: options.backupDirectories,
        onProgress: report,
      });
      // 迁移备份失败必须零写；WAL 配置在 runner COMMIT 后做，不提前改文件持久化模式。
      options.signal?.throwIfAborted();
      await retrySqliteBusy(() => db.exec("PRAGMA journal_mode = WAL"), waitOptions());
      options.signal?.throwIfAborted();
      db.exec("PRAGMA synchronous = NORMAL");
    });
    // COMMIT 已成功，先发布事实；后续 close 失败不能把已提交误报为未提交。
    options.signal?.throwIfAborted();
    report("maintaining", migration);
    options.signal?.throwIfAborted();
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    db.close();
  } catch (error) {
    // 不在 finally 抛错，也不用异常的 truthiness 判断成功；保留首因包括 undefined/null。
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
  if (failed) {
    if (migration && failure && typeof failure === "object") {
      try {
        Object.assign(failure, { startupMigration: { ...migration } });
      } catch {
        /* 不可扩展异常仍保留原错误。 */
      }
    }
    throw failure;
  }
  options.signal?.throwIfAborted();
  markTasksStorageMigrated(path);
  const repos = [
    new TaskIndexRepo(path, BUSINESS_BUSY_TIMEOUT_MS),
    new AutomationRepo(path, BUSINESS_BUSY_TIMEOUT_MS),
  ];
  let preparationFailed = false;
  let preparationFailure: unknown;
  try {
    // 这些是原本就在初始化时执行的修复，不创建新的迁移或改变已有事务边界。
    for (const repo of repos) {
      options.signal?.throwIfAborted();
      await repo.ensureReady();
      options.signal?.throwIfAborted();
    }
  } catch (error) {
    preparationFailed = true;
    preparationFailure = error;
  }
  for (const repo of repos) {
    try {
      repo.close({ throwOnError: true });
    } catch (error) {
      if (!preparationFailed) {
        preparationFailed = true;
        preparationFailure = error;
      }
    }
  }
  if (preparationFailed) {
    if (migration && preparationFailure && typeof preparationFailure === "object") {
      try {
        Object.assign(preparationFailure, { startupMigration: { ...migration } });
      } catch {
        /* 保留投影维护首因。 */
      }
    }
    throw preparationFailure;
  }
  options.signal?.throwIfAborted();
  markTasksStoragePrepared(path);
  report("ready", migration);
}
