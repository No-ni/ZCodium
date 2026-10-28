import { isAbsolute, resolve } from "node:path";
import { resolveSourceDataRoots, type SourceDataRoots } from "@zcode/shared/node";

export function resolveSourcePersistenceRoots(
  env: Record<string, string | undefined>,
): SourceDataRoots | undefined {
  if (!Object.hasOwn(env, "ZCODE_SERVER_ROOT")) return undefined;
  return resolveSourceDataRoots(env.ZCODE_SERVER_ROOT ?? "");
}

export function assertSourceUserConfigPathAllowed(
  userConfigPath: string | undefined,
  roots: SourceDataRoots,
): void {
  if (userConfigPath === undefined) return;
  // loadFileConfig 可迁移写回；Source 显式配置路径必须在读取前证明属于唯一持久根。
  if (!isAbsolute(userConfigPath) || resolve(userConfigPath) !== roots.cliConfigFile)
    throw new Error("Source persistence is active: config path rejected");
}
