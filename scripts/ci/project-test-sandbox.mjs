import { lstat, mkdir, mkdtemp, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const projectRoot = resolve(import.meta.dirname, "../..");
export const projectValidationRoot = join(projectRoot, ".run-logs", "project-only-validation");
const rejected = () => new Error("PROJECT_TEST_PATH_REJECTED");

function contained(parent, path) {
  const suffix = relative(parent, path);
  return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function validateLabel(label) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(label)) throw rejected();
}

export async function assertProjectPath(path) {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) throw rejected();
  const target = resolve(path);
  if (!contained(projectRoot, target)) throw rejected();
  // 字符串包含关系无法防止 junction 写穿；创建目录前逐级确认真实目录，不跟随重解析点。
  const root = parse(target).root;
  let current = root;
  for (const segment of relative(root, target).split(sep)) {
    current = join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
    if (info.isSymbolicLink() || (!info.isDirectory() && current !== target)) throw rejected();
    const actual = await realpath(current);
    if (relative(current, actual) !== "") throw rejected();
  }
  return target;
}

async function ensureDirectory(path) {
  const target = await assertProjectPath(path);
  await mkdir(target, { recursive: true });
  await assertProjectPath(target);
  if (!(await lstat(target)).isDirectory()) throw rejected();
  return target;
}

async function boundSandbox(env) {
  const path = env.PROJECT_TEST_SANDBOX_ROOT;
  if (!path) throw rejected();
  const target = await assertProjectPath(path);
  if (!contained(projectValidationRoot, target) || !(await lstat(target)).isDirectory()) {
    throw rejected();
  }
  return target;
}

function environment(root, paths, inherited) {
  const env = { ...inherited };
  for (const key of Object.keys(env)) {
    if (
      /^(?:zcode_|zcodium_|node_options$|node_compile_cache$|tsx_tsconfig_path$|node_test_context$|project_test_sandbox_root$)/i.test(
        key,
      )
    ) {
      delete env[key];
    }
  }
  const fixed = {
    PROJECT_TEST_SANDBOX_ROOT: root,
    HOME: paths.home,
    USERPROFILE: paths.home,
    ZCODE_DESKTOP_HOME_DIR: paths.home,
    APPDATA: paths.appData,
    LOCALAPPDATA: paths.localAppData,
    TEMP: paths.temp,
    TMP: paths.temp,
    TMPDIR: paths.temp,
    XDG_CONFIG_HOME: paths.config,
    XDG_CACHE_HOME: paths.cache,
    XDG_DATA_HOME: paths.data,
    ZCODE_DATA_BASE_DIR: paths.data,
    ZCODIUM_DATA_DIR: paths.data,
    ZCODE_STORAGE_DIR: join(paths.data, ".zcodium"),
    ZCODE_SESSION_DB_PATH: join(paths.data, ".zcodium", "cli", "db", "db.sqlite"),
    ZCODE_SESSION_DB: join(paths.data, ".zcodium", "cli", "db", "db.sqlite"),
    ZCODE_LOG_DIR: paths.logs,
    ZCODE_GEN_UI_OUTPUT_ROOT: join(root, "visualizations"),
    ZCODE_LOCAL_RESOURCE_MONITORING: "0",
    TSX_DISABLE_CACHE: "1",
    NODE_DISABLE_COMPILE_CACHE: "1",
    COREPACK_ENABLE_NETWORK: "0",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    COREPACK_ENABLE_AUTO_PIN: "0",
    npm_config_update_notifier: "false",
    npm_config_cache: paths.cache,
    npm_config_userconfig: join(paths.config, "npmrc"),
    npm_config_globalconfig: join(paths.config, "global-npmrc"),
    PNPM_HOME: join(paths.cache, "pnpm"),
    TURBO_CACHE_DIR: join(paths.cache, "turbo"),
    TURBO_TELEMETRY_DISABLED: "1",
    DO_NOT_TRACK: "1",
    GIT_OPTIONAL_LOCKS: "0",
  };
  for (const key of Object.keys(env)) {
    if (Object.keys(fixed).some((name) => name.toLowerCase() === key.toLowerCase()))
      delete env[key];
  }
  Object.assign(env, fixed);
  const quotedRoot = JSON.stringify(root);
  // 这是 Node 文件写入的附加白名单，不把它当作原生扩展或任意 shell 的完整系统沙箱。
  env.NODE_OPTIONS = `--permission --allow-fs-read=* --allow-fs-write=${quotedRoot} --allow-child-process --allow-worker --allow-addons`;
  return env;
}

export async function createProjectTestSandbox(label, { env = process.env } = {}) {
  validateLabel(label);
  const parent = env.PROJECT_TEST_SANDBOX_ROOT
    ? join(await boundSandbox(env), "children")
    : projectValidationRoot;
  await ensureDirectory(parent);
  const root = await mkdtemp(join(parent, `${label}-`));
  await assertProjectPath(root);
  const paths = {
    home: join(root, "home"),
    temp: join(root, "temp"),
    appData: join(root, "appdata"),
    localAppData: join(root, "local-appdata"),
    config: join(root, "config"),
    cache: join(root, "cache"),
    data: join(root, "data"),
    logs: join(root, "logs"),
  };
  for (const path of Object.values(paths)) await ensureDirectory(path);
  return { root, ...paths, env: environment(root, paths, env) };
}

export async function createProjectTestFixture(label, env = process.env) {
  validateLabel(label);
  const parent = join(await boundSandbox(env), "fixtures");
  await ensureDirectory(parent);
  const path = await mkdtemp(join(parent, `${label}-`));
  return assertProjectPath(path);
}

/** Node permission 模式禁止 symlink；固定子进程只执行已验证的夹具两端，不扩大父进程写白名单。 */
export async function createProjectTestSymlink(target, path, type, env = process.env) {
  const sandbox = await boundSandbox(env);
  const linkPath = await assertProjectPath(resolve(path));
  const targetPath = await assertProjectPath(resolve(parse(linkPath).dir, target));
  if (!contained(sandbox, linkPath) || !contained(sandbox, targetPath)) throw rejected();
  if (type !== undefined && type !== "dir" && type !== "file") throw rejected();
  const run = promisify(execFile);
  // Windows 使用 PowerShell 7 的 .NET API，支持悬空目标；操作数仅由已校验 env 传递。
  if (process.platform === "win32") {
    await run(
      "pwsh.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        type === "dir"
          ? "[System.IO.Directory]::CreateSymbolicLink($env:PROJECT_TEST_LINK_PATH, $env:PROJECT_TEST_LINK_TARGET) | Out-Null"
          : "[System.IO.File]::CreateSymbolicLink($env:PROJECT_TEST_LINK_PATH, $env:PROJECT_TEST_LINK_TARGET) | Out-Null",
      ],
      {
        windowsHide: true,
        env: { ...env, PROJECT_TEST_LINK_PATH: linkPath, PROJECT_TEST_LINK_TARGET: targetPath },
      },
    );
  } else {
    await run("ln", ["-s", "--", targetPath, linkPath], { env });
  }
  if (!(await lstat(linkPath)).isSymbolicLink()) throw rejected();
}
