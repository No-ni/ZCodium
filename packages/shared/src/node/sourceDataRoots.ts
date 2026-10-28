import { dirname, isAbsolute, join, resolve } from "node:path";
import { ZCODE_APP_CONFIG_SUBDIR_NAME, ZCODE_USER_DATA_DIR_NAME } from "../appDirNames.js";

export interface SourceDataRoots {
  readonly serverRoot: string;
  readonly dataBaseDir: string;
  readonly dataRoot: string;
  readonly storageDir: string;
  readonly configRoot: string;
  readonly providerConfigRoot: string;
  readonly settingsFile: string;
  readonly taskDatabasePath: string;
  readonly cliConfigFile: string;
  readonly sessionDatabasePath: string;
}

export function resolveSourceDataRoots(serverRoot: string): SourceDataRoots {
  if (!serverRoot || !serverRoot.trim() || serverRoot.includes("\0") || !isAbsolute(serverRoot))
    throw new Error("Invalid Source server root");
  const root = resolve(serverRoot);
  if (root === dirname(root)) throw new Error("Invalid Source server root");
  const dataBaseDir = join(root, "data");
  const dataRoot = join(dataBaseDir, ZCODE_USER_DATA_DIR_NAME);
  const configRoot = join(dataRoot, ZCODE_APP_CONFIG_SUBDIR_NAME);
  return Object.freeze({
    serverRoot: root,
    dataBaseDir,
    dataRoot,
    storageDir: dataRoot,
    configRoot,
    providerConfigRoot: configRoot,
    settingsFile: join(configRoot, "setting.json"),
    taskDatabasePath: join(configRoot, "tasks-index.sqlite"),
    cliConfigFile: join(dataRoot, "cli", "config.json"),
    sessionDatabasePath: join(dataRoot, "cli", "db", "db.sqlite"),
  });
}

export function createSourcePersistenceEnv<T extends string | undefined>(
  serverRoot: string,
  env: Readonly<Record<string, T>>,
): Record<string, T | string> {
  const paths = resolveSourceDataRoots(serverRoot);
  const fixed = {
    ZCODE_SERVER_ROOT: paths.serverRoot,
    ZCODE_DATA_BASE_DIR: paths.dataBaseDir,
    ZCODE_STORAGE_DIR: paths.storageDir,
    ZCODE_SESSION_DB_PATH: paths.sessionDatabasePath,
    ZCODE_SESSION_DB: paths.sessionDatabasePath,
  };
  const result: Record<string, T | string> = {};
  for (const [key, value] of Object.entries(env)) {
    // Windows spawn 按大小写变体选择键；先移除继承别名，不能仅追加大写键固定 Source 根。
    if (!Object.hasOwn(fixed, key.toUpperCase())) result[key] = value;
  }
  return { ...result, ...fixed };
}
