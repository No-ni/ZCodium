import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  windowsTokens,
  exactOption,
  descendants,
  cpuPercent,
  matchesSamplerMain,
  parseProcessRows,
} from "../../docs/testing/qa-2026-11-06/process-sampler-calculations.mjs";
import { createProjectTestSandbox, projectRoot } from "../ci/project-test-sandbox.mjs";

test("采样纯计算保留精确参数、父进程时刻和 PID 重用边界", () => {
  const tokens = windowsTokens('electron.exe "--app=C:\\project files\\main.js" --run=test');
  assert.equal(exactOption(tokens, "--app", "C:/project files/main.js", true), true);
  assert.equal(exactOption([...tokens, "--run=other"], "--run", "test"), false);
  assert.equal(windowsTokens('electron.exe "unfinished'), null);
  const rows = [
    { pid: 1, ppid: 0, createdAt: "2026-11-21T00:00:00Z" },
    { pid: 2, ppid: 1, createdAt: "2026-11-21T00:00:01Z" },
    { pid: 3, ppid: 1, createdAt: "2026-11-20T00:00:00Z" },
  ];
  assert.deepEqual(
    descendants(rows, 1).map((row) => row.pid),
    [1, 2],
  );
  const previous = { createdAt: "same", cpuTicks: "10000", capturedAt: 1000 };
  assert.equal(cpuPercent({ createdAt: "same", cpuTicks: "10010000" }, previous, 2000), 100);
  assert.equal(cpuPercent({ createdAt: "reused", cpuTicks: "10010000" }, previous, 2000), null);
  assert.equal(cpuPercent({ createdAt: "same", cpuTicks: "0" }, previous, 2000), null);
  const row = {
    name: "electron.exe",
    executable: "C:/synthetic-repo/electron.exe",
    command:
      "electron.exe --zcode-e2e-run-id=test --zcode-e2e-home=C:/synthetic-repo/home --app=C:/synthetic-repo/main.js",
  };
  const scope = {
    repository: "C:/synthetic-repo",
    targetRunId: "test",
    targetHome: "C:/synthetic-repo/home",
    appEntry: "C:/synthetic-repo/main.js",
  };
  assert.equal(matchesSamplerMain(row, scope), true);
  assert.equal(
    matchesSamplerMain({ ...row, command: row.command + " --type=renderer" }, scope),
    false,
  );
  assert.equal(parseProcessRows('{"ProcessId":12,"ParentProcessId":1}')[0].pid, 12);
});

test("bootstrap 路径 adapter 继续拒绝越界与未知 preload，合法合成路径可读", async () => {
  const sandbox = await createProjectTestSandbox("qa-path-guard");
  const require = createRequire(import.meta.url);
  const {
    createBootstrapPathGuards,
  } = require("../../docs/testing/qa-2026-11-06/bootstrap-path-guards.cjs");
  const guards = createBootstrapPathGuards({
    repository: projectRoot,
    fixtureDirectory: join(projectRoot, "docs/testing/qa-2026-11-06"),
    desktopRequire: { resolve: () => join(sandbox.root, "loader.mjs") },
  });
  assert.equal(guards.insideWorktree(sandbox.root), sandbox.root);
  assert.throws(() => guards.insideWorktree(projectRoot), /escapes/u);
  assert.throws(() => guards.insideWorktree(join(projectRoot, "..", "outside")), /escapes/u);
  assert.throws(() => guards.insideWorktree("relative/path"), /absolute/u);
  assert.throws(() => guards.validateWdioNodeOptions("--require unsafe-preload"), /unknown/u);
});
