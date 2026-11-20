import { execFile } from "node:child_process";
import { cp, mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  assertProjectPath,
  createProjectTestSandbox,
} from "../../../../../scripts/ci/project-test-sandbox.mjs";

const cacheDir = (home: string) =>
  join(home, ".zcodium", "cli", "plugins", "cache", "zcode-plugins-official");
/** 只使用当前随包 seed；模板是本轮项目内路径，不清理既有目录或远端拉取。 */
export async function prepareBundledPluginCacheTemplate(input: {
  cliEntryPoint: string;
  templateHome: string;
}) {
  await assertProjectPath(input.cliEntryPoint);
  await assertProjectPath(input.templateHome);
  const sandbox = await createProjectTestSandbox("e2e-bundled-seed");
  await mkdir(input.templateHome, { recursive: true });
  await promisify(execFile)(process.execPath, [input.cliEntryPoint, "plugin", "list"], {
    cwd: input.templateHome,
    env: {
      ...sandbox.env,
      HOME: input.templateHome,
      USERPROFILE: input.templateHome,
      ZCODE_DATA_BASE_DIR: input.templateHome,
      ZCODE_DESKTOP_HOME_DIR: input.templateHome,
    },
    timeout: 180_000,
    windowsHide: true,
  });
  await access(await assertProjectPath(cacheDir(input.templateHome)));
}
export async function installBundledPluginCacheTemplate(input: {
  homeDir: string;
  templateHome: string;
}) {
  const source = await assertProjectPath(cacheDir(input.templateHome));
  const target = await assertProjectPath(cacheDir(input.homeDir));
  try {
    await access(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  await cp(source, target, { recursive: true });
  return true;
}
