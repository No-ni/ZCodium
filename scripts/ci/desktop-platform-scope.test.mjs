import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../..");

test("desktop packaging accepts Windows/macOS and rejects Linux before building", () => {
  for (const os of ["mac", "win", "linux"]) {
    for (const arch of ["x64", "arm64"]) {
      const result = spawnSync(
        process.execPath,
        ["packages/desktop/scripts/bundle.mjs", "--os", os, "--arch", arch, "--dry-run"],
        { cwd: root, encoding: "utf8", timeout: 20_000 },
      );
      assert.ifError(result.error);
      assert.equal(result.status, os === "linux" ? 1 : 0, result.stderr);
      if (os === "linux") assert.match(result.stderr, /不支持的目标操作系统/);
      else assert.match(result.stdout, new RegExp(`--${os} --${arch}`));
    }
  }
});

test("desktop preparation stages only local runtime scripts", async () => {
  // 执行准备入口并拦截子命令；不用真的构建或下载资源，仍能发现偷偷恢复的 Linux producer。
  const result = await build({
    stdin: {
      contents:
        'import "./packages/desktop/scripts/prepare-runtime-assets.mjs"; export { calls } from "./scripts/spawn-command.mjs";',
      resolveDir: root,
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    define: {
      "import.meta.url": JSON.stringify(
        pathToFileURL(resolve(root, "packages/desktop/scripts/prepare-runtime-assets.mjs")).href,
      ),
      "process.env.ZCODE_TARGET_OS": '"mac"',
      "process.env.ZCODE_TARGET_ARCH": '"arm64"',
    },
    plugins: [
      {
        name: "runtime-command-fixture",
        setup(builder) {
          builder.onResolve({ filter: /spawn-command\.mjs$/ }, () => ({
            path: "commands",
            namespace: "fixture",
          }));
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents:
              "export const calls = []; export function runCommand(command, args) { calls.push(args[0]); }",
            loader: "js",
          }));
        },
      },
    ],
  });
  const code = new TextDecoder().decode(result.outputFiles[0].contents);
  const prepared = await import(
    `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
  );
  assert.ok(prepared.calls.includes("prepare:agent-bundle"));
  assert.ok(prepared.calls.every((command) => !command.includes("remote")));
});

test("desktop configuration keeps mobile assets without bundling a Linux runtime", () => {
  for (const os of ["mac", "win", "linux"]) {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'const { default: config } = await import("./packages/desktop/electron-builder.config.js"); console.log(JSON.stringify({ linux: config.linux, mac: config.mac.target, win: config.win.target, resources: config.extraResources.map(entry => entry.to) }));',
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 20_000,
        env: { ...process.env, ZCODE_TARGET_OS: os, ZCODE_TARGET_ARCH: "arm64" },
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, os === "linux" ? 1 : 0, result.stderr);
    if (os === "linux") {
      assert.match(result.stderr, /Unsupported desktop target OS/);
      continue;
    }
    const config = JSON.parse(result.stdout);
    assert.equal(config.linux, undefined);
    assert.deepEqual(config.mac, ["dmg"]);
    assert.deepEqual(config.win, ["nsis"]);
    assert.ok(config.resources.includes("web-remote"));
    assert.ok(!config.resources.includes("remote-assets"));
  }
});

test("CI schedules only Windows/macOS packages and no Linux remote producer", async () => {
  const desktop = parse(await readFile(resolve(root, ".github/workflows/desktop.yml"), "utf8"));
  const mac = parse(await readFile(resolve(root, ".github/workflows/macos.yml"), "utf8"));
  assert.deepEqual(
    desktop.jobs.build.strategy.matrix.include.map(({ platform, arch }) => [platform, arch]),
    [
      ["win", "x64"],
      ["win", "arm64"],
    ],
  );
  assert.deepEqual(
    desktop.jobs["build-macos"].strategy.matrix.include.map(({ arch }) => arch),
    ["arm64", "x64"],
  );
  assert.deepEqual(Object.keys(mac.jobs), ["build"]);
  for (const workflow of [desktop, mac]) {
    assert.equal(workflow.jobs["remote-assets"], undefined);
    for (const job of Object.values(workflow.jobs)) {
      assert.ok(![job.needs].flat().includes("remote-assets"));
      for (const step of job.steps ?? []) {
        assert.ok(!/prepare:remote-assets|bundle-remote-assets/.test(step.run ?? ""));
        assert.ok(!/linux|bundled-remote/.test(step.with?.name ?? ""));
      }
    }
  }
});
