import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";
import { readUpstreamSnapshot } from "./architecture/upstream-snapshot.mjs";
import { assertProjectPath, createProjectTestSandbox } from "./ci/project-test-sandbox.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const execute = promisify(execFile);

export async function runFormatter({ cwd = projectRoot, args = [] } = {}) {
  const sandbox = await createProjectTestSandbox("format-gate");
  const snapshotPath = "scripts/ci/upstream-format-snapshot.json";
  const { accepted } = await readUpstreamSnapshot(cwd, snapshotPath);
  const { config, error } = ts.parseConfigFileTextToJson(
    ".oxfmtrc.json",
    await readFile(join(cwd, ".oxfmtrc.json"), "utf8"),
  );
  if (error) throw new Error("FORMAT_CONFIG_INVALID");
  // 原因：永久路径排除会把后续本仓修改一起隐藏；只排除两份 Git 快照均匹配的继承文件。
  const temporaryConfig = await assertProjectPath(join(cwd, `.oxfmt-gate-${randomUUID()}.json`));
  // 原因：POSIX 绝对 ignore 路径会被当作配置目录锚点；同目录配置保留跨平台的相对规则。
  const ignorePatterns = [
    ...(config.ignorePatterns ?? []),
    ...[...accepted].map((pattern) => `/${pattern.replace(/[[\]*?{}]/g, "\\$&")}`),
    basename(temporaryConfig),
  ];
  await writeFile(temporaryConfig, JSON.stringify({ ...config, ignorePatterns }), { flag: "wx" });
  try {
    // 显式文件参数会绕过 oxfmt 的 ignore；同一已核验文件在 write/check 都必须保持原样。
    const formatterArgs = args.filter((argument) => {
      if (argument.startsWith("-")) return true;
      return !accepted.has(relative(cwd, resolve(cwd, argument)).replaceAll("\\", "/"));
    });
    const hadTargets = args.some((argument) => !argument.startsWith("-"));
    if (hadTargets && !formatterArgs.some((argument) => !argument.startsWith("-"))) {
      return { exitCode: 0, stdout: "", stderr: "", inheritedFiles: accepted.size };
    }
    const formatterEnv = { ...sandbox.env };
    if (!args.includes("--check") && !args.includes("--list-different")) {
      const suffix = relative(projectRoot, cwd);
      if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
        throw new Error("FORMAT_WRITE_PATH_REJECTED");
      }
      if (cwd !== projectRoot) await assertProjectPath(cwd);
      for (const target of formatterArgs.filter((argument) => !argument.startsWith("-"))) {
        const path = resolve(cwd, target);
        if (path !== projectRoot) await assertProjectPath(path);
      }
      // write 只给当前项目 cwd 写入权；缓存与其他临时文件继续留在 sandbox。
      formatterEnv.NODE_OPTIONS = formatterEnv.NODE_OPTIONS.replace(
        `--allow-fs-write=${JSON.stringify(sandbox.root)}`,
        `--allow-fs-write=${JSON.stringify(cwd)}`,
      );
    }
    try {
      const output = await execute(
        process.execPath,
        [
          join(projectRoot, "node_modules/oxfmt/bin/oxfmt"),
          ...formatterArgs,
          "--config",
          temporaryConfig,
        ],
        { cwd, env: formatterEnv, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      );
      return { exitCode: 0, ...output, inheritedFiles: accepted.size };
    } catch (error) {
      if (typeof error.code !== "number") throw error;
      return {
        exitCode: error.code,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
        inheritedFiles: accepted.size,
      };
    }
  } finally {
    await unlink(await assertProjectPath(temporaryConfig));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runFormatter({ args: process.argv.slice(2) });
  process.stdout.write(
    `format: ${result.inheritedFiles} verified inherited files\n${result.stdout}`,
  );
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
