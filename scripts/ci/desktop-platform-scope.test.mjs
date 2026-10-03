import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { parse } from "yaml";
import {
  removeSourceMapFilesInDirectory,
  stripSourceMappingUrlCommentsInDirectory,
} from "../../packages/desktop/scripts/packaged-sourcemap-cleanup.mjs";

const root = resolve(import.meta.dirname, "../..");

test("packaged Gen UI snapshots retain their hashes after sourcemap cleanup", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "zcodium-gen-ui-snapshot-"));
  const source = resolve(
    root,
    "apps/zcode-cli/packages/visualize-plugin/skills/visualize/assets/vendor",
  );
  const manifest = JSON.parse(await readFile(resolve(source, "manifest.json"), "utf8"));
  const files = new Map();
  for (const resource of manifest.resources) {
    files.set(resource.file, resource.sha256);
    files.set(resource.licenseFile, resource.licenseSha256);
  }
  try {
    const copies = [
      "out/plugin-sandbox/vendor",
      "glm/packages/visualize-plugin/skills/visualize/assets/vendor",
    ];
    for (const copy of copies) {
      await mkdir(resolve(directory, copy), { recursive: true });
      for (const file of files.keys()) {
        await writeFile(resolve(directory, copy, file), await readFile(resolve(source, file)));
      }
    }
    const ordinaryJs = resolve(directory, "out/main/index.js");
    await mkdir(resolve(directory, "out/main"), { recursive: true });
    await writeFile(ordinaryJs, 'console.log("fixture");\n//# sourceMappingURL=index.js.map\n');
    await writeFile(`${ordinaryJs}.map`, "{}");
    stripSourceMappingUrlCommentsInDirectory(directory);
    removeSourceMapFilesInDirectory(directory);
    for (const copy of copies) {
      for (const [file, expected] of files) {
        const bytes = await readFile(resolve(directory, copy, file));
        assert.equal(createHash("sha256").update(bytes).digest("hex"), expected, `${copy}/${file}`);
      }
    }
    assert.doesNotMatch(await readFile(ordinaryJs, "utf8"), /sourceMappingURL/);
    await assert.rejects(access(`${ordinaryJs}.map`), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows checkout preserves the pinned Gen UI asset hashes", async () => {
  // 实测 Windows 检出把 vendor 和许可文件转换为 CRLF，构建的原始字节校验因此失败。
  const assets = "apps/zcode-cli/packages/visualize-plugin/skills/visualize/assets";
  const runtime = JSON.parse(
    await readFile(resolve(root, assets, "runtime-manifest.json"), "utf8"),
  );
  const vendor = JSON.parse(await readFile(resolve(root, assets, "vendor/manifest.json"), "utf8"));
  const files = new Map(
    Object.entries(runtime.files).map(([file, entry]) => [
      file === "tweak.js"
        ? "packages/desktop/src/renderer/src/plugin-sandbox/genUiTweakRuntime.js"
        : `${assets}/${file}`,
      entry.sha256,
    ]),
  );
  for (const resource of vendor.resources) {
    files.set(`${assets}/vendor/${resource.file}`, resource.sha256);
    files.set(`${assets}/vendor/${resource.licenseFile}`, resource.licenseSha256);
  }
  for (const [file, expected] of files) {
    const result = spawnSync(
      "git",
      ["-c", "core.autocrlf=true", "cat-file", "--filters", `HEAD:${file}`],
      { cwd: root, timeout: 20_000 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(createHash("sha256").update(result.stdout).digest("hex"), expected, file);
  }
});

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
  for (const targetOs of ["darwin", "win32"]) {
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
            // 源码显式 import process，esbuild define 无法替换其环境读取；CI 检查机是 Ubuntu。
            // 直接提供目标平台 fixture，避免把宿主平台误当成被测桌面目标。
            builder.onResolve({ filter: /target-platform\.mjs$/ }, () => ({
              path: "target",
              namespace: "target-fixture",
            }));
            builder.onLoad({ filter: /.*/, namespace: "target-fixture" }, () => ({
              contents: `export function getTargetPlatform() { return { os: ${JSON.stringify(targetOs)}, arch: "arm64", key: ${JSON.stringify(`${targetOs}-arm64`)} }; }`,
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
    assert.equal(prepared.calls.includes("prepare:macos-window-bounds"), targetOs === "darwin");
  }
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
