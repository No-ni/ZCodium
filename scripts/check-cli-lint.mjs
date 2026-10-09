import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const cliRoot = resolve(root, "apps/zcode-cli");
// 只枚举 workspace 的直接子包，检查现有 Lint 入口涵盖的源码与 debug/test 目录。
const paths = ["packages", "tools"].flatMap((group) =>
  readdirSync(resolve(cliRoot, group), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(cliRoot, group, entry.name, "src"))
    .filter((path) => existsSync(path)),
);
paths.push(
  resolve(cliRoot, "packages/debug/server"),
  resolve(cliRoot, "packages/debug/scripts"),
  resolve(cliRoot, "tools/repo-snapshot-parody/test"),
);
// 显式配置隔离根 Lint 的 CLI 忽略规则；不依赖子 workspace 的 .bin 或全局 pnpm。
const result = spawnSync(
  process.execPath,
  [
    resolve(root, "node_modules/oxlint/bin/oxlint"),
    "--config",
    resolve(cliRoot, "oxlint.config.json"),
    ...paths,
  ],
  { cwd: root, stdio: "inherit" },
);

if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
else process.exitCode = result.status ?? 1;
