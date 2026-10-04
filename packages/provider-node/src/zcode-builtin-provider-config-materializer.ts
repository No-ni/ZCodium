import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import {
  decodeZCodeBuiltinRelease,
  serializeZCodeBuiltinRelease,
} from "./zcode-builtin-release.js";

export interface MaterializeZCodeBuiltinProviderConfigOptions {
  readonly environmentConfigRoot: string;
  readonly content: string;
}

/**
 * 物化副本在环境目录下的相对位置。
 * 单独导出常量：main 侧「打开 Provider 配置」入口要推导同一路径，
 * 若在两处各写一遍字面量，将来改布局时只会改到其中一处。
 */
export const ZCODE_BUILTIN_PROVIDER_CONFIG_RELATIVE_PATH = [
  "runtime",
  "provider",
  "bundled",
  "zcode-builtin.json",
] as const;

export function resolveZCodeBuiltinProviderConfigFilePath(environmentConfigRoot: string): string {
  return join(environmentConfigRoot, ...ZCODE_BUILTIN_PROVIDER_CONFIG_RELATIVE_PATH);
}

/**
 * 在环境目录释放唯一随包基线；升级以退出旧进程为前提，不保留历史 hash 副本。
 * 复用统一锁及原子写入，避免并发启动读到半份 JSON。
 */
export async function materializeZCodeBuiltinProviderConfig(
  options: MaterializeZCodeBuiltinProviderConfigOptions,
): Promise<string> {
  const content = `${serializeZCodeBuiltinRelease(
    decodeZCodeBuiltinRelease(JSON.parse(options.content)),
  )}\n`;
  const filePath = resolveZCodeBuiltinProviderConfigFilePath(options.environmentConfigRoot);
  await withFileLock(filePath, async () => {
    if ((await readOptionalFile(filePath)) !== content) {
      await atomicWritePrivateTextFile(filePath, content);
    }
  });
  return filePath;
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
