import { decodeFilePathUriEscapes, isAbsoluteFilePath, joinFilePath } from "@/lib/path.js";
import { stripBalancedAssistantPathQuotes } from "@/lib/assistantPathQuotes.js";

interface ParsedMarkdownFileLink {
  path: string;
  lineNumber: number | null;
  columnNumber: number | null;
}

export interface MarkdownFileLinkResolveOptions {
  /** 当前 workspace Host 报告的用户 Home；Renderer 不自行读取本机 Home。 */
  homePath?: string;
  /** 文件必须留在这个 workspace 身份边界内；缺席时沿用相对解析基准。 */
  workspaceRootPath?: string;
}

const LINE_AND_COLUMN_SUFFIX_RE = /^(?<path>.+):(?<line>\d+):(?<column>\d+)$/;
const LINE_SUFFIX_RE = /^(?<path>.+):(?<line>\d+)$/;
const HASH_LINE_SUFFIX_RE = /^(?<path>.+)#L(?<line>\d+)(?:-L?\d+)?$/i;
const FILE_URL_PROTOCOL_RE = /^file:\/\//i;
const HARDEN_SAFE_WINDOWS_ABSOLUTE_PATH_RE = /^\/(?:[a-zA-Z]:|UNC:)\//;
const COMMON_UNIX_ABSOLUTE_ROOT_SEGMENTS = new Set([
  "Applications",
  "Library",
  "System",
  "Users",
  "Volumes",
  "bin",
  "boot",
  "dev",
  "etc",
  "home",
  "lib",
  "lib64",
  "media",
  "mnt",
  "opt",
  "private",
  "proc",
  "root",
  "run",
  "sbin",
  "srv",
  "sys",
  "tmp",
  "usr",
  "var",
]);

function isWorkspaceRelativeFileHref(href: string): boolean {
  return href.startsWith("./");
}

function normalizeHomeRelativePath(path: string): string | null {
  if (path.startsWith("./~/") || path.startsWith("./~\\")) {
    return path.slice(2);
  }
  return /^~[\\/]/.test(path) ? path : null;
}

function isHomeRelativeFilePath(path: string): boolean {
  return normalizeHomeRelativePath(path) !== null;
}

function isUnsupportedNamedHomePath(path: string): boolean {
  return /^~[^\\/]+[\\/]/.test(path);
}

function resolveHomeRelativeFilePath(path: string, homePath: string | undefined): string | null {
  const homeRelativePath = normalizeHomeRelativePath(path);
  if (!homeRelativePath || !homePath || !isAbsoluteFilePath(homePath)) {
    return null;
  }

  const separator = homePath.includes("\\") && !homePath.includes("/") ? "\\" : "/";
  return joinFilePath(homePath, homeRelativePath.slice(2).replace(/[\\/]/g, separator));
}

function isBareWorkspaceRelativeFileHref(href: string): boolean {
  if (
    !href ||
    href.startsWith("/") ||
    href.startsWith("#") ||
    /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(href)
  ) {
    return false;
  }

  return href.includes("/") || href.includes("\\");
}

function isAbsoluteMarkdownFileHref(rawHref: string, normalizedHref: string): boolean {
  return (
    isAbsoluteFilePath(rawHref) ||
    isAbsoluteFilePath(normalizedHref) ||
    normalizedHref.startsWith("//")
  );
}

function isLikelyUnixAbsoluteFilePath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//")) {
    return false;
  }

  const firstSegment = path.slice(1).split("/")[0];
  return Boolean(firstSegment && COMMON_UNIX_ABSOLUTE_ROOT_SEGMENTS.has(firstSegment));
}

function isPathInsideWorkspaceRoot(path: string, workspacePath: string): boolean {
  let normalizedPath = path.replace(/\\/g, "/").replace(/\/$/, "");
  let normalizedWorkspacePath = workspacePath.replace(/\\/g, "/").replace(/\/$/, "");
  // 根因：Windows 文档路径与身份根可能只有大小写不同，敏感比较会在 harden 前删掉合法引用。
  // 仅按盘符/UNC 形状折叠，不能用 Renderer 平台影响 POSIX 远端；实际输出保留原始拼写。
  if (/^(?:[a-zA-Z]:\/|\/\/)/.test(normalizedWorkspacePath)) {
    normalizedPath = normalizedPath.toLowerCase();
    normalizedWorkspacePath = normalizedWorkspacePath.toLowerCase();
  }
  return (
    normalizedPath === normalizedWorkspacePath ||
    normalizedPath.startsWith(`${normalizedWorkspacePath}/`)
  );
}

function parseFileUrlPath(path: string): string | null {
  if (!FILE_URL_PROTOCOL_RE.test(path)) {
    return null;
  }

  try {
    const url = new URL(path);
    if (url.protocol !== "file:") {
      return null;
    }

    const decodedPathname = decodeFilePathUriEscapes(url.pathname);
    if (/^\/[a-zA-Z]:\//.test(decodedPathname)) {
      return decodedPathname.slice(1);
    }

    if (url.hostname && url.hostname !== "localhost") {
      return `//${url.hostname}${decodedPathname}`;
    }

    return decodedPathname;
  } catch {
    return null;
  }
}

function normalizeMarkdownFilePath(path: string): string {
  return parseFileUrlPath(path) ?? decodeFilePathUriEscapes(path);
}

export function normalizeWorkspaceRelativeFilePath(relativePath: string): string | null {
  const segments: string[] = [];
  for (const segment of relativePath.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        // 只检查路径是否以 ../ 开头是不够的：嵌套回退会在拼接后逃逸 workspace。
        // 这里在 Renderer 发起 stat/checkFilesExist 前做跨平台词法归一，根目录下溢时直接拒绝。
        return null;
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return segments.join("/");
}

function resolveContainedWorkspaceRelativePath(
  workspacePath: string,
  relativePath: string,
): string | null {
  const normalizedRelativePath = normalizeWorkspaceRelativeFilePath(relativePath);
  if (normalizedRelativePath === null) return null;

  const separator = workspacePath.includes("\\") && !workspacePath.includes("/") ? "\\" : "/";
  return joinFilePath(workspacePath, normalizedRelativePath.replaceAll("/", separator));
}

function resolveContainedDocumentRelativePath(
  documentPath: string,
  workspaceRootPath: string,
  relativePath: string,
): string | null {
  if (!isPathInsideWorkspaceRoot(documentPath, workspaceRootPath)) return null;
  const normalizedDocumentPath = documentPath.replace(/\\/g, "/").replace(/\/$/, "");
  const normalizedWorkspaceRootPath = workspaceRootPath.replace(/\\/g, "/").replace(/\/$/, "");
  const relativeDocumentPath =
    normalizedDocumentPath === normalizedWorkspaceRootPath
      ? ""
      : normalizedDocumentPath.slice(normalizedWorkspaceRootPath.length + 1);
  return resolveContainedWorkspaceRelativePath(
    workspaceRootPath,
    [relativeDocumentPath, relativePath].filter(Boolean).join("/"),
  );
}

export function parseMarkdownFileLinkTarget(href: string): ParsedMarkdownFileLink {
  // 只在路径归一化阶段解码一次；入口提前 decode 会让 `%2520` 变成 `%20`，
  // 再由 normalizeMarkdownFilePath 解码成空格，破坏文件名中的字面 percent-escape。
  const normalizedHref = stripBalancedAssistantPathQuotes(href).replace(/\\/g, "/");
  const withHashLineMatch = normalizedHref.match(HASH_LINE_SUFFIX_RE);
  if (withHashLineMatch?.groups) {
    const { path, line } = withHashLineMatch.groups;
    if (path && line) {
      return {
        path: normalizeMarkdownFilePath(path),
        lineNumber: Number.parseInt(line, 10),
        columnNumber: null,
      };
    }
  }

  const withLineAndColumnMatch = normalizedHref.match(LINE_AND_COLUMN_SUFFIX_RE);
  if (withLineAndColumnMatch?.groups) {
    const { path, line, column } = withLineAndColumnMatch.groups;
    if (path && line && column) {
      return {
        path: normalizeMarkdownFilePath(path),
        lineNumber: Number.parseInt(line, 10),
        columnNumber: Number.parseInt(column, 10),
      };
    }
  }

  const withLineMatch = normalizedHref.match(LINE_SUFFIX_RE);
  if (withLineMatch?.groups) {
    const { path, line } = withLineMatch.groups;
    if (path && line) {
      return {
        path: normalizeMarkdownFilePath(path),
        lineNumber: Number.parseInt(line, 10),
        columnNumber: null,
      };
    }
  }

  return {
    path: normalizeMarkdownFilePath(normalizedHref),
    lineNumber: null,
    columnNumber: null,
  };
}

export function resolveMarkdownFileLink(
  workspacePath: string | undefined,
  href: string,
  options: MarkdownFileLinkResolveOptions = {},
): ParsedMarkdownFileLink | null {
  // 聊天消息里的本地文件链接现在既可能是 `./src/app.ts` 这种文档相对路径，
  // 也可能是 `/abs/path/app.ts:30` 这种绝对路径 + 行号。
  // 相对基准由调用方提供，身份边界由 workspaceRootPath 单独提供；只看到前导 `/` 就当成
  // workspace 子路径会让绝对路径被再拼一次前缀，
  // 同时 `:30` 也会混进文件名里。这里先拆掉可选行号，再把“相对路径”和“绝对路径”分开解析。
  const parsedTarget = parseMarkdownFileLinkTarget(href);
  const workspaceRootPath = options.workspaceRootPath ?? workspacePath;

  if (isUnsupportedNamedHomePath(parsedTarget.path)) {
    return null;
  }

  const homePath = resolveHomeRelativeFilePath(parsedTarget.path, options.homePath);
  if (isHomeRelativeFilePath(parsedTarget.path)) {
    return homePath
      ? {
          ...parsedTarget,
          path: homePath,
        }
      : null;
  }

  if (HARDEN_SAFE_WINDOWS_ABSOLUTE_PATH_RE.test(parsedTarget.path)) {
    // `/C:/...` 与 `/UNC:/...` 是 harden 的内部格式；UNC 若直接交给 URL 归一会丢掉 server。
    // 只在 Windows 路径作用域对称还原，不能将这种内部格式解释成 POSIX 相对文件。
    if (
      !workspaceRootPath ||
      !/^(?:[a-zA-Z]:\/|\/\/)/.test(workspaceRootPath.replace(/\\/g, "/"))
    ) {
      return null;
    }
    return {
      ...parsedTarget,
      path: parsedTarget.path.startsWith("/UNC:/")
        ? parsedTarget.path.replace(/^\/UNC:\//, "//")
        : parsedTarget.path.slice(1),
    };
  }

  // UNC 是绝对路径；不能落入前导 / 的文档相对路径分支后被再拼一次执行根。
  if (parsedTarget.path.startsWith("//")) return parsedTarget;

  if (
    isWorkspaceRelativeFileHref(parsedTarget.path) ||
    isBareWorkspaceRelativeFileHref(parsedTarget.path)
  ) {
    if (!workspacePath || !workspaceRootPath) {
      return null;
    }

    const relativePath = isWorkspaceRelativeFileHref(parsedTarget.path)
      ? parsedTarget.path.slice(2)
      : parsedTarget.path;
    if (!relativePath) {
      return null;
    }

    const containedPath = resolveContainedDocumentRelativePath(
      workspacePath,
      workspaceRootPath,
      relativePath,
    );
    if (!containedPath) return null;

    return {
      ...parsedTarget,
      path: containedPath,
    };
  }

  if (
    workspacePath &&
    workspaceRootPath &&
    parsedTarget.path.startsWith("/") &&
    !isLikelyUnixAbsoluteFilePath(parsedTarget.path)
  ) {
    // 远程 workspace 常见 `/workspace`、`/repo` 这类非系统根目录。
    // 如果链接已经位于当前 workspace 身份边界内，不能再按文档目录相对路径拼接一次。
    if (isPathInsideWorkspaceRoot(parsedTarget.path, workspaceRootPath)) {
      return parsedTarget;
    }
    // Streamdown/rehype-harden 会把 `./flappy.html` 规范化成 `/flappy.html`。
    // 这里的前导 `/` 表示 markdown 根相对链接，不是系统根目录；否则会误去 stat `/flappy.html`。
    const containedPath = resolveContainedWorkspaceRelativePath(
      workspacePath,
      parsedTarget.path.slice(1),
    );
    if (!containedPath) return null;
    return {
      ...parsedTarget,
      path: containedPath,
    };
  }

  if (isAbsoluteMarkdownFileHref(href, parsedTarget.path)) {
    return parsedTarget;
  }

  return null;
}
