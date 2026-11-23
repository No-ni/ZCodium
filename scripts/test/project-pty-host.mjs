import { readFile, writeFile, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { assertProjectPath, projectRoot } from "../ci/project-test-sandbox.mjs";

const configPath = await assertProjectPath(process.argv[2]);
const config = JSON.parse(await readFile(configPath, "utf8"));
await assertProjectPath(config.file);
await assertProjectPath(config.options.cwd);
for (const [name, path] of Object.entries(config.options.env))
  if (
    /^(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|XDG_.*_HOME|ZCODE_(?:DATA_BASE_DIR|STORAGE_DIR|SESSION_DB_PATH|BUILTIN_PROVIDER_CONFIG_FILE|PERSONAL_PROVIDER_CONFIG_FILE))$/i.test(
      name,
    )
  )
    await assertProjectPath(path);
if (!config.options.env.NODE_OPTIONS?.includes("--permission"))
  throw new Error("PTY_CHILD_PERMISSION_GUARD_REQUIRED");
const { spawn } = createRequire(join(projectRoot, "packages/desktop/package.json"))("node-pty");
let batchPath;
let file = config.file,
  args = config.args;
if (process.platform === "win32") {
  const argv = [config.file, ...config.args];
  if (argv.some((value) => typeof value !== "string" || /[%!&|<>^\r\n"]/u.test(value)))
    throw new Error("INVALID_PTY_FIXTURE_ARG");
  batchPath = await assertProjectPath(configPath + ".cmd");
  await writeFile(
    batchPath,
    "@echo off\r\nchcp 65001 > nul\r\n" +
      argv.map((value) => '"' + value + '"').join(" ") +
      "\r\nexit /b %ERRORLEVEL%\r\n",
    { flag: "wx" },
  );
  file = join(process.env.SystemRoot ?? "C:/Windows", "System32/cmd.exe");
  args = ["/d", "/q", "/c", batchPath];
}
const pty = spawn(file, args, config.options);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
pty.onData((data) => send({ type: "data", data }));
pty.onExit(async ({ exitCode }) => {
  if (batchPath) await unlink(batchPath);
  // PTY 已完成真实退出，发送退出码后结束仅持有 IPC 的 helper；CLI 的关闭仍由其自身 owner 完成。
  process.stdout.write(JSON.stringify({ type: "exit", exitCode }) + "\n", () => process.exit(0));
});
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "write" && typeof command.data === "string") pty.write(command.data);
  else if (command.type === "kill") pty.kill();
  else throw new Error("INVALID_PTY_FIXTURE_COMMAND");
});
process.on("SIGTERM", () => pty.kill());
send({ type: "ready" });
