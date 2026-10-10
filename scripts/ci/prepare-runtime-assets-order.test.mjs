import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";

test("bundle 各种跳过组合只准备一次运行时资产", async () => {
  const root = resolve(import.meta.dirname, "../..");
  const source = await readFile(resolve(root, "packages/desktop/scripts/bundle.mjs"), "utf8");
  const start = source.indexOf("const buildScript =");
  const end = source.indexOf('await runTimedAsync("bundle:electron-builder"', start);
  assert.ok(start >= 0 && end > start);
  const stage = source.slice(start, end);
  const pkg = JSON.parse(await readFile(resolve(root, "packages/desktop/package.json"), "utf8"));
  assert.match(pkg.scripts.build, /prepare:runtime-assets/);
  assert.doesNotMatch(pkg.scripts["build:no-runtime-assets"], /prepare:runtime-assets/);
  for (const [skipPrepare, skipBuild, expected] of [
    [false, false, ["prepare:runtime-assets", "build:no-runtime-assets"]],
    [true, false, ["build"]],
    [false, true, ["prepare:runtime-assets"]],
    [true, true, []],
  ]) {
    const calls = [];
    runInNewContext(stage, {
      skipPrepare,
      skipBuild,
      pnpmCommand: "pnpm",
      buildEnv: {},
      run: (_cmd, args) => calls.push(args[0]),
    });
    assert.deepEqual(calls, expected);
  }
});
