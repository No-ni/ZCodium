import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
export {
  directoryExists,
  fileExists,
  throwIfAborted,
  PLUGIN_MATERIAL_READ_CONCURRENCY,
  type PluginMaterialReader,
  PluginMaterialCache,
  pluginSourcesChanged,
  isPluginMaterialChange,
  rethrowPluginMaterialInterrupt,
  waitForPluginQuery,
} from "./plugin-material-cache.js";

const PLUGIN_FS_RETRY_DELAYS_MS = [0, 25, 100] as const;

/** 只重试同一次目录提交的暂态 OS 错误；事务资格由调用方持有。 */
export async function renamePluginDirectory(source: string, target: string): Promise<void> {
  for (const [index, delayMs] of PLUGIN_FS_RETRY_DELAYS_MS.entries()) {
    if (delayMs > 0) await delay(delayMs);
    try {
      await rename(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Windows 目录 rename 多轮出现间歇 EPERM；不能因此删除旧缓存或重建提交 owner。
      if (
        process.platform !== "win32" ||
        !["EPERM", "EBUSY", "EACCES"].includes(code ?? "") ||
        index === PLUGIN_FS_RETRY_DELAYS_MS.length - 1
      )
        throw error;
      const absent = await stat(target).then(
        () => false,
        (inspectionError) => (inspectionError as NodeJS.ErrnoException).code === "ENOENT",
      );
      // 目标已出现或无法证明缺席时，保持原异常，不能在重试中覆盖另一个提交结果。
      if (!absent) throw error;
    }
  }
}

export async function writePluginTextIfChanged(path: string, contents: string): Promise<void> {
  try {
    if ((await readFile(path, "utf8")) === contents) return;
  } catch {
    // 与原写入语义一致：读失败继续写，让实际写入错误向上传递。
  }
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, contents, "utf8");
    // 异步读写允许查询交错；原子替换避免读者看到半份目录或命令。
    for (const [index, delayMs] of PLUGIN_FS_RETRY_DELAYS_MS.entries()) {
      if (delayMs > 0) await delay(delayMs);
      try {
        await rename(temporary, path);
        return;
      } catch (error) {
        // Windows 索引器可能短暂占用目标；有界重试仍保留旧文件与原子替换。
        const code = (error as NodeJS.ErrnoException).code;
        if (
          !["EACCES", "EBUSY", "EEXIST", "ENOTEMPTY", "EPERM"].includes(code ?? "") ||
          index === PLUGIN_FS_RETRY_DELAYS_MS.length - 1
        )
          throw error;
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** marker 来自磁盘，前缀不能证明是同目录名；join 会把 ../ 规范化成插件目录外的删除目标。 */
export function isAtomicStagingName(targetName: string, stageName: string): boolean {
  const prefix = `.${targetName}.stage-`;
  return (
    stageName.startsWith(prefix) &&
    stageName.length > prefix.length &&
    !/[\\/:]/u.test(stageName) &&
    !stageName.includes("\0")
  );
}

export function resolveInside(rootPath: string, rawPath: string): string | null {
  if (isAbsolute(rawPath)) return null;
  const resolved = resolve(rootPath, rawPath);
  const rel = relative(rootPath, resolved);
  if (rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`))) return resolved;
  return null;
}

export function sanitizePluginId(pluginId: string): string {
  return pluginId.replace(/[^a-zA-Z0-9_.@-]/g, "-");
}

export function parsePathList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

export function isPluginOptionValue(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export async function cleanupPluginSourceBestEffort(
  cleanup: (() => Promise<void>) | undefined,
  retryDelaysMs: readonly number[] = PLUGIN_FS_RETRY_DELAYS_MS,
): Promise<unknown> {
  if (!cleanup) return undefined;
  let cleanupError: unknown;
  for (const delayMs of retryDelaysMs) {
    if (delayMs > 0) {
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delayMs));
    }
    try {
      await cleanup();
      return undefined;
    } catch (error) {
      cleanupError = error;
    }
  }
  return cleanupError;
}

export function appendPluginSourceCleanupError(
  primaryError: unknown,
  cleanupError: unknown,
): unknown {
  if (cleanupError === undefined || !(primaryError instanceof Error)) return primaryError;
  const cleanupMessage =
    cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
  // 临时目录删除失败只能作为附加诊断，不能覆盖下载、校验或解压的原始错误。
  primaryError.message = `${primaryError.message}; plugin source cleanup also failed: ${cleanupMessage}`;
  return primaryError;
}

export async function directoryExistsAsync(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function fileExistsAsync(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * 「路径缺失」只认 ENOENT/ENOTDIR（stat 的精确错误码）。EACCES 等权限错误
 * 不是缺失——调用方不得据此发「不存在」诊断，避免把权限问题误报成 manifest 配错。
 */
export async function isMissingPathAsync(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}
