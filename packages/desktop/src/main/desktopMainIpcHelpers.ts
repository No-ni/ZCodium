import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserWindow } from "electron";
import { shell } from "electron";

type DesktopIpcLogger = {
  info?: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

/**
 * Desktop Main「外部打开」出口分流（QA-BUG-003）。
 *
 * 缺陷原因：`PlatformChannels.OpenExternal` 曾把 http/https/file 统一交给
 * `shell.openExternal`。内置浏览器对本地 file URL 点「在默认浏览器中打开」时，
 * 系统关联程序收到的是 URL 文本，而不是本地路径；`shell.openPath` 一次也没被调用。
 * 修复依据见 docs/browser-use/2026-07-31-browser-toolbar-more-menu-spec.md §3.1：
 * - file: 必须解码成本地路径后走 `shell.openPath`，不得把 file URL 当外部 URL 传出；
 * - http:/https: 继续走 `shell.openExternal`，URL 原样传递；
 * - 其他协议、非法 file host 一律 fail-closed，不调用任何 shell 出口。
 *
 * 分流放在本文件是为了让「外部 URL / 本地路径」共用同一个原生出口 owner：
 * 这里已经拥有 `openPathInDefaultApp`，两个入口（OpenExternal 通道与 file URL 兼容入口）
 * 复用同一份规则，不再各自 `fileURLToPath`。
 */
export type ExternalOpenRejectionReason =
  | "invalid-url"
  | "unsupported-protocol"
  | "unsupported-file-host"
  | "invalid-file-url";

/** 分流结果：外部 URL 原样交给 openExternal；本地路径交给 openPath 出口。 */
export type ExternalOpenTarget =
  | { kind: "external-url"; url: string }
  | { kind: "local-path"; path: string };

export type ResolvedExternalOpen =
  | { ok: true; target: ExternalOpenTarget }
  | { ok: false; reason: ExternalOpenRejectionReason };

/** 原生出口：Main 注入 electron shell 与既有的本地路径打开实现。 */
export type ExternalOpenNativeExit = {
  openExternal: (url: string) => void | Promise<unknown>;
  openPathInDefaultApp: (path: string) => Promise<{ success: boolean; error?: string }>;
};

const EXTERNAL_URL_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

/**
 * 把 renderer 传来的 URL 分流成「外部 URL」或「本地路径」，不做任何 IO。
 *
 * 判定顺序固定为：解析 URL → 协议白名单 → file host 白名单 → 解码本地路径。
 * 任一步失败都返回 ok:false，调用方必须直接放弃，不允许降级成 openExternal 兜底。
 */
export function resolveExternalOpen(rawUrl: string): ResolvedExternalOpen {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid-url" };
  }

  if (EXTERNAL_URL_PROTOCOLS.has(url.protocol)) {
    // http/https 保持原有出口和参数：不解码、不改写，避免改变 OAuth 等既有链接语义。
    return { ok: true, target: { kind: "external-url", url: rawUrl } };
  }

  if (url.protocol !== "file:") {
    return { ok: false, reason: "unsupported-protocol" };
  }

  // 合法 file URL 的 host 只允许空或 localhost。WHATWG URL 解析已把 file URL 的
  // localhost（含大小写变体）归一成空串，所以这里判非空 host 就等价于「空或 localhost」。
  // 必须自己判：本仓 Node 24 在 Windows 上不会因远端 host 抛错，
  // fileURLToPath("file://server/share/x.html") 会直接返回 \\server\share\x.html，
  // 等于把 UNC/远端共享交给 shell.openPath，因此这里 fail-closed。
  if (url.hostname !== "") {
    return { ok: false, reason: "unsupported-file-host" };
  }

  try {
    // 百分号（含字面 % 的 %25）、空格 %20、中文多字节、Windows 盘符全部交给标准库解码，
    // 不手写 decodeURIComponent，也不做字符串拼接。
    return { ok: true, target: { kind: "local-path", path: fileURLToPath(url) } };
  } catch {
    return { ok: false, reason: "invalid-file-url" };
  }
}

/**
 * 按分流结果调用对应原生出口。
 *
 * fail-closed：分流失败时不触达任何出口；出口自身失败只记 warn，不向 renderer 抛错
 * （OpenExternal 通道契约 response 为 void，renderer 端也没有错误分支）。
 */
export async function handleExternalOpenRequest(
  rawUrl: string,
  exit: ExternalOpenNativeExit,
  logger: DesktopIpcLogger,
): Promise<void> {
  const resolved = resolveExternalOpen(rawUrl);
  if (!resolved.ok) {
    // 原因：不回显完整 URL/本地路径，避免把用户绝对路径写进日志；稳定 reason 足够定位。
    logger.warn("[open-external] blocked unsupported url", { reason: resolved.reason });
    return;
  }

  if (resolved.target.kind === "external-url") {
    try {
      await exit.openExternal(resolved.target.url);
    } catch (error) {
      logger.warn("[open-external] 外部 URL 打开失败", {
        protocol: "http(s)",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  try {
    // 本地路径打开失败由既有 openPathInDefaultApp 统一记录（含 success:false 分支）。
    await exit.openPathInDefaultApp(resolved.target.path);
  } catch (error) {
    logger.warn("[open-external] 本地文件打开失败", {
      kind: "local-path",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function openFileUrlInDefaultApp(
  url: string,
  logger: DesktopIpcLogger,
): Promise<void> {
  // 与 PlatformChannels.OpenExternal 共用同一条 file URL 规则（host 白名单 +
  // fileURLToPath 解码）：两处各自 fileURLToPath 会再次把 UNC/远端 host 当本地路径打开。
  const resolved = resolveExternalOpen(url);
  if (!resolved.ok || resolved.target.kind !== "local-path") {
    logger.warn("[open-external] blocked unsupported url", {
      reason: resolved.ok ? "unsupported-protocol" : resolved.reason,
    });
    return;
  }
  await openPathInDefaultApp(resolved.target.path, logger);
}

export async function openPathInDefaultApp(
  rawPath: string,
  logger: DesktopIpcLogger,
): Promise<{ success: boolean; error?: string }> {
  const trimmed = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!trimmed) {
    const error = "empty path";
    logger.warn("[open-external] 本地文件打开失败", { path: rawPath, error });
    return { success: false, error };
  }

  const normalized = normalize(trimmed);
  let target = normalized;
  try {
    target = await realpath(normalized);
  } catch {
    // 路径不存在或无法解析时仍尝试用规范化后的原路径，让系统返回更具体的错误。
  }

  try {
    const error = await shell.openPath(target);
    if (error) {
      logger.warn("[open-external] 本地文件打开失败", { path: target, error });
      return { success: false, error };
    }
    logger.info?.("[open-external] 本地文件打开成功", { path: target });
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("[open-external] 本地文件打开失败", { path: target, error: message });
    return { success: false, error: message };
  }
}

export async function openPathInFileManager(
  rawPath: string,
  logger: DesktopIpcLogger,
): Promise<{ success: boolean; error?: string }> {
  const trimmed = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!trimmed) {
    return { success: false, error: "empty path" };
  }
  const normalized = normalize(trimmed);
  let target = normalized;
  try {
    target = await realpath(normalized);
  } catch {
    // 路径不存在或无法解析时仍尝试用规范化后的原路径打开，便于定位权限等问题。
  }

  if (process.platform === "darwin") {
    return openDarwinPathInFileManager(target, logger);
  }

  const error = await shell.openPath(target);
  if (error) {
    logger.warn("[open-in-file-manager] shell.openPath 失败", {
      path: target,
      error,
    });
    return { success: false, error };
  }
  return { success: true };
}

export async function captureWindowScreenshot(senderWindow: BrowserWindow | null) {
  if (!senderWindow || senderWindow.isDestroyed()) {
    return null;
  }

  // 报错横幅里的反馈需要带上用户看到的现场。
  // 这里在 main 进程截当前窗口，避免 renderer 走屏幕录制权限或只能截到局部 DOM。
  const image = await senderWindow.webContents.capturePage();
  const buffer = image.toPNG();
  return {
    dataBase64: buffer.toString("base64"),
    filename: `zcode-error-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
    contentType: "image/png",
    size: buffer.byteLength,
  };
}

async function openDarwinPathInFileManager(target: string, logger: DesktopIpcLogger) {
  const runOpen = (args: string[]) =>
    new Promise<void>((resolve, reject) => {
      execFile("open", args, (error) => (error ? reject(error) : resolve()));
    });

  try {
    await runOpen([target]);
    return { success: true };
  } catch (firstError) {
    try {
      await runOpen(["-a", "Finder", target]);
      return { success: true };
    } catch (finderError) {
      const shellMessage = await shell.openPath(target);
      if (!shellMessage) {
        return { success: true };
      }
      logger.warn("[open-in-file-manager] macOS 打开目录均失败", {
        path: target,
        shellMessage,
        firstError: firstError instanceof Error ? firstError.message : String(firstError),
        finderError: finderError instanceof Error ? finderError.message : String(finderError),
      });
      return { success: false, error: shellMessage };
    }
  }
}
