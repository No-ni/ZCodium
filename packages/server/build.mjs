import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runCommand } from "../../scripts/spawn-command.mjs";

export function buildServer({ env = process.env, run = runCommand } = {}) {
  const options = { cwd: import.meta.dirname, env };
  run("pnpm", ["exec", "tsup"], options);
  // CI 已从独立 producer 下载并验证 remote artifact；通用 workspace build 曾再次生成同一 bundle。
  // 复用既有资产 opt-out，避免按旧 dist 猜测；默认 build 与直接 build:remote 仍完整从源码构建。
  if (env.ZCODE_SKIP_REMOTE_ASSETS !== "1") {
    run("pnpm", ["run", "build:remote"], options);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildServer();
}
