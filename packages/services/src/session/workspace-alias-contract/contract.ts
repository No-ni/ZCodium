import { join } from "node:path";
import { ZCODE_USER_DATA_DIR_NAME } from "@zcode/shared";

/** 装配层向官方 Repo 注入本仓路径；不改双库迁移实现或生成第二个状态 owner。 */
export function resolveSourceWorkspaceAliasStoragePaths(dataBaseDir: string): {
  sessionDbPath: string;
  backupRoot: string;
} {
  return {
    sessionDbPath: join(dataBaseDir, ZCODE_USER_DATA_DIR_NAME, "cli", "db", "db.sqlite"),
    backupRoot: join(dataBaseDir, ZCODE_USER_DATA_DIR_NAME, "server", "migration-backups"),
  };
}
