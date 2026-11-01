import { realpath, stat } from "node:fs/promises";
import * as path from "node:path";

type PathApi = Pick<typeof path, "relative" | "isAbsolute" | "sep">;

export function isInsideDirectory(root: string, candidate: string, paths: PathApi = path): boolean {
  const diff = paths.relative(root, candidate);
  // Windows 跨盘/UNC 的 relative 结果仍可能是绝对路径；只拒绝完整父目录段，
  // 不能把合法的 ..asset 或 dir.. 名称误当成路径穿越。
  return (
    diff === "" || (!paths.isAbsolute(diff) && diff !== ".." && !diff.startsWith(`..${paths.sep}`))
  );
}

export async function resolveStaticFile(
  staticRoot: string,
  pathname: string,
  spaFallback: boolean,
): Promise<string | null> {
  const root = path.resolve(staticRoot);
  const normalizedPathname = pathname === "/" ? "/index.html" : pathname;
  const relativePath = decodeURIComponent(normalizedPathname).replace(/^\/+/, "");
  let candidate = path.resolve(root, relativePath);
  if (!isInsideDirectory(root, candidate)) return null;

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch {
    return null;
  }

  try {
    // 词法包含不能阻止静态目录内的链接/junction 越界；所有返回分支都核对真实目标。
    const canonicalCandidate = await realpath(candidate);
    if (!isInsideDirectory(canonicalRoot, canonicalCandidate)) return null;
    const candidateStat = await stat(canonicalCandidate);
    if (candidateStat.isDirectory()) {
      candidate = path.resolve(candidate, "index.html");
      const canonicalIndex = await realpath(candidate);
      if (!isInsideDirectory(canonicalRoot, canonicalIndex)) return null;
      const indexStat = await stat(canonicalIndex);
      return indexStat.isFile() ? candidate : null;
    }
    if (candidateStat.isFile()) {
      // 返回已校验的逻辑路径，保留 alias 的 Content-Type 与 index.html 缓存头。
      return candidate;
    }
  } catch {
    // 静态资源未命中时再进入 SPA fallback，保留真实文件错误的 404 语义。
  }

  if (!spaFallback) return null;
  const indexFile = path.resolve(root, "index.html");
  try {
    const canonicalIndex = await realpath(indexFile);
    if (!isInsideDirectory(canonicalRoot, canonicalIndex)) return null;
    const indexStat = await stat(canonicalIndex);
    return indexStat.isFile() ? indexFile : null;
  } catch {
    return null;
  }
}
