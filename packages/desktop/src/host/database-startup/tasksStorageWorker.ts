import { parentPort, workerData } from "node:worker_threads";
import { tasksStorageWorkerDataSchema } from "./contract.js";
import { createSettingService, prepareTasksIndexStorage } from "@zcode/services/storage-startup";
import {
  classifyDatabaseStartupError,
  databaseStartupErrorDetails,
  databaseMigrationFactsSchema,
} from "@zcode/shared";

const data = tasksStorageWorkerDataSchema.parse(workerData);
try {
  // 修复原因：首次项目迁移只读取旧设置保留的项目；未等待设置会以空清单提交 0005。
  // 设置仍由 Worker 所属 Host 读取，第三参沿用启动 options，不进入 workerData/进度消息。
  const settings = await createSettingService().get();
  await prepareTasksIndexStorage(
    data.path,
    (phase, migration) => parentPort?.postMessage({ type: "progress", phase, migration }),
    { settings },
  );
  parentPort?.postMessage({ type: "done" });
} catch (error) {
  const migration = databaseMigrationFactsSchema.safeParse(
    error && typeof error === "object"
      ? (error as { startupMigration?: unknown }).startupMigration
      : undefined,
  );
  parentPort?.postMessage({
    type: "failed",
    migration: migration.success ? migration.data : undefined,
    errorCode: classifyDatabaseStartupError(error),
    ...databaseStartupErrorDetails(error),
  });
} finally {
  parentPort?.close();
}
