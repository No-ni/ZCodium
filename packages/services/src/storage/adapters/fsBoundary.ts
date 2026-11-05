import type { Stats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

function boundaryError(code: "ELOOP" | "EOUTSIDE" | "ENOTDIR"): Error {
  return Object.assign(new Error("Storage filesystem boundary rejected"), { code });
}

/** 扫描和删除共用的当前路径检查；不复用扫描时的结果，也不跟随数据根祖先中的链接。 */
export async function assertUnlinkedStoragePath(
  rootPath: string,
  candidatePath: string,
): Promise<Stats> {
  const root = resolve(rootPath);
  const target = resolve(candidatePath);
  const suffix = relative(root, target);
  if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`)) {
    throw boundaryError("EOUTSIDE");
  }
  // 只检查 root 下的 dirent 无法阻止 root/prefix 自身或其祖先为 junction。
  // 按当前路径逐段 lstat，并复验真实路径；Windows relative 保留大小写不敏感语义。
  let current = parse(target).root;
  let info = await lstat(current);
  for (const segment of relative(current, target).split(sep).filter(Boolean)) {
    current = join(current, segment);
    info = await lstat(current);
    if (info.isSymbolicLink() || relative(current, await realpath(current)) !== "") {
      throw boundaryError("ELOOP");
    }
    if (current !== target && !info.isDirectory()) throw boundaryError("ENOTDIR");
  }
  return info;
}
