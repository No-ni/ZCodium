import { execFile } from "node:child_process";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { assertProjectPath, projectRoot } from "./project-test-sandbox.mjs";

/** 准备真实软链夹具；链接与目标均属于当前工作树，原生 helper 再独立核对一次。 */
export async function createProjectSymlinkFixture(target, link) {
  const taskTarget = await assertProjectPath(target);
  const taskLink = await assertProjectPath(link);
  if (process.platform !== "win32") return symlink(taskTarget, taskLink);
  await promisify(execFile)(
    join(process.env.ProgramFiles ?? "C:/Program Files", "PowerShell/7/pwsh.exe"),
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      join(projectRoot, "scripts/test/create-project-symlink.ps1"),
      "-TargetPath",
      taskTarget,
      "-LinkPath",
      taskLink,
    ],
    { cwd: projectRoot, env: process.env, windowsHide: true },
  );
}
