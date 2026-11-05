// 官方 3.17.1 合并的 CLI 域边界回归：产品身份、剥离的官方后端、以及"未吸收完的悬空引用"棘轮。
// 用 node:test；静态检查只读仓库，命令边界回归仅使用项目内隔离夹具，不联网。
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, it } from "node:test";
import { execFile } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { createProjectTestFixture } from "../../../../../scripts/ci/project-test-sandbox.mjs";

const cliRoot = resolve(import.meta.dirname, "..", "..", "..");
const repoRoot = resolve(cliRoot, "..", "..");

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;

/** 逐条列出"仍指向本仓已删除官方后端、但引用方还没清干净"的相对导入；只能减少，不能新增。 */
const DANGLING_BASELINE = new Set<string>([
  "packages/adapters/src/mcp/pool.ts|./telemetry.js",
  "packages/adapters/src/model/endpoint-routing-edition/index.ts|../official-coding-plan-gateway.js",
  "packages/adapters/src/model/failure-classifier.ts|./runner-runtime-headers.js",
  "packages/adapters/src/model/runner-generate.ts|./runner-debug.js",
  "packages/adapters/src/model/runner-generate.ts|./runner-runtime-headers.js",
  "packages/adapters/src/model/runner-generate.ts|./runner-telemetry.js",
  "packages/adapters/src/model/runner-stream.ts|./runner-runtime-headers.js",
  "packages/adapters/tests/anthropic-request-metadata.test.ts|../src/device/cli-device-mid.js",
  "packages/adapters/tests/mcp-connection-pool.test.ts|../src/mcp/telemetry.js",
  "packages/adapters/tests/mcp-official-auth.test.ts|../src/mcp/official-auth.js",
  "packages/adapters/tests/mcp-process-lifecycle.test.ts|../src/mcp/telemetry.js",
  "packages/adapters/tests/mcp-resource-telemetry.test.ts|../src/mcp/telemetry.js",
  "packages/adapters/tests/mcp-telemetry.test.ts|../src/mcp/telemetry.js",
  "packages/adapters/tests/mcp.test.ts|../src/mcp/telemetry.js",
  "packages/adapters/tests/official-coding-plan-gateway.test.ts|../src/model/official-coding-plan-gateway.js",
  "packages/adapters/tests/project-token-cancellation.test.ts|../src/auth/coding-plan-api-key.js",
  "packages/adapters/tests/project-token-refresh.test.ts|../src/auth/coding-plan-api-key.js",
  "packages/adapters/tests/runner-debug-failed-stream.test.ts|../src/model/runner-debug.js",
  "packages/adapters/tests/runner-debug-media-redaction.test.ts|../src/model/runner-debug.js",
  "packages/adapters/tests/runner-options.test.ts|../src/model/opencode-session.js",
  "packages/adapters/tests/zai-business-token-refresh.test.ts|../src/auth/coding-plan-api-key.js",
  "packages/bootstrap/src/auth-login-persistence.ts|./app/standalone-account-provider-runtime.js",
  "packages/bootstrap/src/model-config.ts|./runtime-platform-headers.js",
  "packages/bootstrap/src/zcode-protocol-entrypoint.ts|./telemetry-bootstrap.js",
  "packages/bootstrap/src/zcode-protocol-entrypoint.ts|./zcode-protocol/official-mcp-auth-port.js",
  "packages/bootstrap/src/zcode-protocol/server-operations.ts|./offpeak-port.js",
  "packages/bootstrap/src/zcode-protocol/server.ts|./account-provider-config.js",
  "packages/bootstrap/src/zcode-protocol/server.ts|./model-io-preferences.js",
  "packages/bootstrap/src/zcode-protocol/server.ts|./off-peak-tool-policy.js",
  "packages/bootstrap/src/zcode-protocol/workspace-model-runtime.ts|./provider-runtime-headers.js",
  "packages/bootstrap/test/local-observability.test.ts|../src/zcode-protocol-v4/local-ttft.js",
  "packages/bootstrap/tests/auth-login.test.ts|../src/app/standalone-account-provider-runtime.js",
  "packages/bootstrap/tests/auth-login.test.ts|../src/auth-login.js",
  "packages/bootstrap/tests/model-io-preferences.test.ts|../src/zcode-protocol/model-io-preferences.js",
  "packages/bootstrap/tests/off-peak-tool-policy.test.ts|../src/zcode-protocol/off-peak-tool-policy.js",
  "packages/bootstrap/tests/official-command-endpoint/endpoint.test.ts|../../src/zcode-protocol/official-mcp-auth-port.js",
  "packages/bootstrap/tests/official-command-endpoint/endpoint.test.ts|../src/zcode-protocol/official-mcp-auth-port.js",
  "packages/bootstrap/tests/official-mcp-auth-port.test.ts|../src/zcode-protocol/official-mcp-auth-port.js",
  "packages/bootstrap/tests/personal-config-default-integration.test.ts|../src/auth-login.js",
  "packages/bootstrap/tests/process-provider-registry-runtime.test.ts|../src/app/standalone-account-provider-runtime.js",
  "packages/bootstrap/tests/provider-runtime-headers-cancel.test.ts|../src/zcode-protocol/provider-runtime-headers.js",
  "packages/bootstrap/tests/runtime-platform-headers.test.ts|../src/runtime-platform-headers.js",
  "packages/bootstrap/tests/standalone-project-token.test.ts|../src/app/standalone-account-provider-runtime.js",
  "packages/bootstrap/tests/telemetry-bootstrap.test.ts|../src/telemetry-bootstrap.js",
  "packages/cli/src/command-center/create.ts|./login-flow.js",
  "packages/cli/src/command-center/create.ts|../tui-login-state.js",
  "packages/cli/tests/tui-login-polling.test.ts|../../bootstrap/src/auth-login.js",
  "packages/cli/tests/tui-login-polling.test.ts|../../bootstrap/src/app/standalone-account-provider-runtime.js",
  "packages/cli/tests/tui-model-selection.test.ts|../../bootstrap/src/tui-login-state.js",
  "packages/cli/tests/tui-login-polling.test.ts|../src/login-command.js",
  "packages/cli/tests/tui-model-selection.test.ts|../src/tui-login-state.js",
  "packages/contracts/src/events/session.events.ts|../telemetry/index.js",
  "packages/contracts/src/index.ts|./interfaces/off-peak.port.js",
  "packages/contracts/src/model/observation.ts|./agent-execution.js",
  "packages/contracts/tests/off-peak.test.ts|../src/tools/off-peak.js",
  "packages/contracts/tests/telemetry.test.ts|../src/telemetry/index.js",
  "packages/core/src/runtime/helpers/project-memory-agent.ts|../methods/model-runtime-headers.js",
  "packages/core/src/runtime/helpers/project-memory-recall.ts|../methods/model-runtime-headers.js",
  "packages/core/src/runtime/internal.ts|../telemetry/runtime-telemetry.js",
  "packages/core/src/tool/handlers/workflow.ts|./off-peak.js",
  "packages/core/tests/child-client-ports.test.ts|../src/runtime/methods/model-runtime-headers.js",
  "packages/debug/tests/network-capture.test.ts|../server/network-capture.js",
  "tools/prompt-trajectory/src/cli.ts|./record.js",
]);

const DOMAIN_GROUPS = ["packages", "tools"];
const EXCLUDED_TOP = new Set(["node-repl-host", "zcode-cua-plugin"]);
const SCAN_DIRS = ["src", "test", "tests", "server", "scripts"];
const MERGE_IN_PROGRESS = /(^|\n)<{7}( |$)/;

function sourceFiles(): string[] {
  const found: string[] = [];
  for (const group of DOMAIN_GROUPS) {
    const groupRoot = join(cliRoot, group);
    if (!existsSync(groupRoot)) continue;
    for (const entry of readdirSync(groupRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || EXCLUDED_TOP.has(entry.name)) continue;
      for (const dir of SCAN_DIRS) {
        const base = join(groupRoot, entry.name, dir);
        if (!existsSync(base)) continue;
        walk(base, found);
      }
    }
  }
  return found;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    // 只扫 TS 源：.mjs 测试夹具里的字符串不是真实依赖边。
    else if (statSync(abs).isFile() && /\.(ts|tsx)$/.test(entry.name)) out.push(abs);
  }
}

function resolves(fromFile: string, spec: string): boolean {
  // 构建产物与外部资源不是源码依赖边。
  if (spec.includes("/dist/") || spec.endsWith("dist/index.js")) return true;
  const base = resolve(dirname(fromFile), spec).replace(/\.js$/, "");
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mjs`,
    join(base, "index.ts"),
    base,
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return true;
  }
  return false;
}

describe("官方 3.17.1 合并的 CLI 边界", () => {
  it("incomplete legacy restore commands provide help and fail closed with zero storage writes", async () => {
    const directory = await createProjectTestFixture("legacy-command-unavailable");
    await writeFile(join(directory, "sentinel.txt"), "keep synthetic bytes");
    const isolatedRoots = [process.env.HOME!, process.env.ZCODE_DATA_BASE_DIR!];
    const originalEntries = await Promise.all(
      isolatedRoots.map((root) => readdir(root, { recursive: true })),
    );
    const execute = promisify(execFile);
    const scripts = join(
      cliRoot,
      "packages/restore-legacy-sessions-plugin/skills/restore-legacy-sessions/scripts",
    );
    for (const name of ["scan-legacy-sessions.mjs", "restore-conversation.mjs"]) {
      const help = await execute(process.execPath, [join(scripts, name), "--help"], {
        env: process.env,
        windowsHide: true,
      });
      assert.match(help.stdout, /Usage:/);
      assert.match(help.stdout, /unavailable/i);
    }
    for (const [name, args, code] of [
      [
        "scan-legacy-sessions.mjs",
        [
          "summary",
          "--legacy-dir",
          join(directory, "source"),
          "--cli-db",
          join(directory, "new-cli/db.sqlite"),
          "--task-index",
          join(directory, "new-index/db.sqlite"),
          "--json",
        ],
        "LEGACY_SCAN_UNAVAILABLE",
      ],
      [
        "restore-conversation.mjs",
        [
          "--snapshot",
          join(directory, "absent.json"),
          "--cli-db",
          join(directory, "new-cli/db.sqlite"),
          "--task-index",
          join(directory, "new-index/db.sqlite"),
        ],
        "LEGACY_RESTORE_UNAVAILABLE",
      ],
      [
        "restore-conversation.mjs",
        ["--snapshot", join(directory, "absent.json"), "--dry-run"],
        "LEGACY_RESTORE_UNAVAILABLE",
      ],
    ] as const) {
      await assert.rejects(
        execute(process.execPath, [join(scripts, name), ...args], {
          env: process.env,
          windowsHide: true,
        }),
        (error: any) =>
          error.code === 2 &&
          error.stderr.includes(code) &&
          !error.stderr.includes("ERR_MODULE_NOT_FOUND"),
      );
    }
    assert.deepEqual(await readdir(directory), ["sentinel.txt"]);
    assert.equal(await readFile(join(directory, "sentinel.txt"), "utf8"), "keep synthetic bytes");
    assert.deepEqual(
      await Promise.all(isolatedRoots.map((root) => readdir(root, { recursive: true }))),
      originalEntries,
    );
  });
  it("CLI manifest 跟随官方 0.17.1，且不恢复 Linux 发行/测试入口", () => {
    const manifest = readJson(join(cliRoot, "package.json"));
    assert.equal(manifest.version, "0.17.1");
    assert.equal(manifest.packageManager, "pnpm@10.33.2");
    assert.ok(
      !("test:browser-headless:linux" in manifest.scripts),
      "不得恢复 Linux docker 测试入口",
    );
    // 本仓根编排入口保持 corepack 与自有 lint 门槛，不被上游覆盖。
    assert.match(manifest.scripts.typecheck as string, /corepack pnpm/);
    assert.match(manifest.scripts.lint as string, /check-cli-lint\.mjs/);
    // 上游新增的测试/覆盖率入口需要被吸收。
    for (const script of ["test", "pretest", "coverage"]) {
      assert.ok(script in manifest.scripts, `缺少上游脚本 ${script}`);
    }
  });

  it("turbo 任务保留内置 provider 配置代际与插件构建块", () => {
    const turbo = readJson(join(cliRoot, "turbo.json"));
    for (const task of ["build:desktop-agent", "@zcode/cli#build"]) {
      assert.ok(
        (turbo.tasks[task].env as string[]).includes("ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"),
        `${task} 需要 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE，否则用户自带配置的缓存判定会分叉`,
      );
    }
    for (const task of ["@zcode/office-runtime#build", "@zcode/node-repl-host#build"]) {
      assert.ok(turbo.tasks[task], `缺少插件构建任务 ${task}`);
    }
    assert.ok(turbo.tasks.test && turbo.tasks.coverage, "上游的 test/coverage 任务未被吸收");
  });

  it("已删除的官方遥测后端不被恢复", () => {
    assert.ok(!existsSync(join(cliRoot, "packages/telemetry")), "packages/telemetry 必须保持删除");
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const body = readFileSync(file, "utf8");
      // 仍在解冲突的文件文本不是最终实现，由棘轮与人工合并阶段负责。
      if (MERGE_IN_PROGRESS.test(body)) continue;
      if (/@zcode\/telemetry|from "\.\/official-auth\.js"|from "\.\/telemetry\.js"/.test(body)) {
        offenders.push(relative(cliRoot, file));
      }
    }
    assert.deepEqual(offenders, [], "源码/测试重新引用了官方遥测后端");
  });

  it("MCP stdio 吸收 Electron Node/npm 回退，且不引入官方鉴权面", () => {
    const adapter = readFileSync(join(cliRoot, "packages/adapters/src/mcp/index.ts"), "utf8");
    assert.match(adapter, /from "\.\/node-fallback\.js"/);
    assert.match(adapter, /applyMcpNodeFallbackEnv\(/);
    assert.match(adapter, /nodeFallback\?: McpNodeFallbackProvider/);
    assert.match(adapter, /createMcpNodeFallbackProvider,/, "宿主注入回退需要公开出口");
    // 本仓保留的进程归属与准入边界不能被上游版本覆盖掉。
    assert.match(adapter, /processTracker/);
    assert.match(adapter, /assertConnectionActive/);
    assert.doesNotMatch(adapter, /official-auth|OfficialMcp|McpTelemetryTracker/);
  });

  it("未吸收完的悬空引用只能减少，不能新增（合并进度棘轮）", () => {
    const current: string[] = [];
    for (const file of sourceFiles()) {
      const body = readFileSync(file, "utf8");
      // 仍在解冲突的文件不参与棘轮：那里的文本还不代表最终实现。
      if (MERGE_IN_PROGRESS.test(body)) continue;
      for (const m of body.matchAll(/from\s+"((?:\.\.?\/)[^"]+)"/g)) {
        if (!resolves(file, m[1]))
          current.push(`${relative(cliRoot, file).split(sep).join("/")}|${m[1]}`);
      }
    }
    const unique = [...new Set(current)];
    const added = unique.filter((entry) => !DANGLING_BASELINE.has(entry));
    assert.deepEqual(added, [], "出现了新的悬空导入（未验证的依赖方向或遗漏的剥离）");
  });
});
