import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { resolveE2EHomeDir, resolveE2ERuntimePath } from "../e2e-runtime-paths.js";

export const NATIVE_CONTEXT_CASE_NAME = "conversation-session-native-context-compression";
const repositoryRoot = resolve(import.meta.dirname, "../../../../../..");

export async function assertNativeContextTestPath(path: string): Promise<string> {
  const target = resolve(path);
  const suffix = relative(repositoryRoot, target);
  if (
    !isAbsolute(path) ||
    !suffix ||
    suffix === ".." ||
    suffix.startsWith(`..${sep}`) ||
    isAbsolute(suffix)
  )
    throw new Error("NCTX test write path must stay within the approved worktree");
  const volume = parse(target).root;
  let cursor = volume;
  for (const part of relative(volume, target).split(sep)) {
    cursor = join(cursor, part);
    let entry;
    try {
      entry = await lstat(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
    if (entry.isSymbolicLink() || relative(cursor, await realpath(cursor)) !== "")
      throw new Error("NCTX test path crosses a junction or symbolic link");
    if (cursor !== target && !entry.isDirectory()) throw new Error("NCTX invalid test path parent");
  }
  return target;
}

/** 没有显式 case-local replay 时拒绝运行；待评审套件不能意外使用用户的模型 Key。 */
export async function prepareNativeContextEvidenceDirectory(): Promise<string> {
  const fixturePaths =
    process.env.E2E_PROVIDER_REPLAY_FIXTURE_PATH?.split(",")
      .map((path) => path.trim())
      .filter(Boolean) ?? [];
  if (
    !fixturePaths.some((path) =>
      path.replaceAll("\\", "/").endsWith(`/${NATIVE_CONTEXT_CASE_NAME}.json`),
    ) ||
    !fixturePaths.some((path) => path.replaceAll("\\", "/").endsWith("/common.json"))
  )
    throw new Error("NCTX requires explicit common and native context case-local replay fixtures");
  for (const path of fixturePaths) await assertNativeContextTestPath(resolve(path));
  for (const key of [
    "HOME",
    "USERPROFILE",
    "TEMP",
    "TMP",
    "APPDATA",
    "LOCALAPPDATA",
    "ZCODE_E2E_HOME_DIR",
    "E2E_PROVIDER_CAPTURE_PATH",
  ]) {
    const path = process.env[key];
    if (!path?.trim()) throw new Error(`NCTX requires project-only ${key}`);
    await assertNativeContextTestPath(path);
  }
  for (const key of [
    "TMPDIR",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "ZCODE_DATA_BASE_DIR",
    "ZCODE_DESKTOP_HOME_DIR",
    "ZCODE_SESSION_DB_PATH",
    "ZCODE_LOG_DIR",
  ]) {
    const path = process.env[key];
    if (path?.trim()) await assertNativeContextTestPath(path);
  }
  await assertNativeContextTestPath(resolveE2EHomeDir());
  const evidence = await assertNativeContextTestPath(
    resolveE2ERuntimePath(NATIVE_CONTEXT_CASE_NAME, "evidence"),
  );
  await mkdir(evidence, { recursive: true });
  return assertNativeContextTestPath(evidence);
}
