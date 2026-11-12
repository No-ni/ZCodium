import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, parse } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import ts from "typescript";
import {
  assertProjectPath,
  createProjectTestSandbox,
  projectRoot,
} from "./project-test-sandbox.mjs";

const execute = promisify(execFile);
const sourceMode = process.env.WINUI_TRAY_SOURCE ?? "workspace";
assert.ok(sourceMode === "HEAD" || sourceMode === "workspace", "SOURCE_MODE_REJECTED");
const sourceFiles = [
  "packages/desktop/src/main/desktopTray.ts",
  "packages/desktop/src/main/unreadBadgePixels.ts",
];
const digest = (data) => createHash("sha256").update(data).digest("hex");

async function compileSource(file) {
  const source =
    sourceMode === "HEAD"
      ? (await execute("git", ["show", `HEAD:${file}`], { cwd: projectRoot, windowsHide: true }))
          .stdout
      : await readFile(await assertProjectPath(join(projectRoot, file)), "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  // 只剥离 import 和类型；托盘、缓存及像素算法全部来自被验收的真实源码。
  const body = ts.transpileModule(
    ast.statements
      .filter((node) => !ts.isImportDeclaration(node))
      .map((node) => node.getText(ast).replace(/^export\s+/u, ""))
      .join("\n")
      .replaceAll("import.meta.dirname", "fixtureMainDirectory"),
    {
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
    },
  ).outputText;
  return { file, sha256: digest(source), body };
}

async function electronBatch() {
  const assert = require("node:assert/strict");
  const { createHash } = require("node:crypto");
  const { readFile, writeFile } = require("node:fs/promises");
  const { join, relative } = require("node:path");
  const { pathToFileURL } = require("node:url");
  const { app, nativeImage, BrowserWindow } = require("electron");
  const config = JSON.parse(process.env.WINUI_TRAY_BATCH_CONFIG);
  app.setName("ZCodium Tray Image Source Regression");
  for (const [name, path] of Object.entries(config.appPaths)) app.setPath(name, path);
  app.disableHardwareAcceleration();
  const classify = (error) => ({
    code: /invalid buffer size/iu.test(String(error?.message))
      ? "invalid-buffer-size"
      : (error?.code ?? error?.name ?? "FAILED"),
    type: error?.name ?? "UnknownError",
  });
  try {
    await app.whenReady();
    const { assertProjectPath } = await import(pathToFileURL(config.sandboxHelper).href);
    for (const [name, path] of Object.entries(config.appPaths)) {
      await assertProjectPath(path);
      assert.equal(relative(path, app.getPath(name)), "", "APP_PATH_OVERRIDE_REQUIRED");
    }
    await assertProjectPath(config.bodyPath);
    await assertProjectPath(config.resultPath);
    const sources = JSON.parse(await readFile(config.bodyPath, "utf8"));
    const evaluate = (body, ports, expression) =>
      new Function(...Object.keys(ports), `${body}\nreturn ${expression};`)(
        ...Object.values(ports),
      );
    const hash = (data) => createHash("sha256").update(data).digest("hex");
    const pixels = evaluate(
      sources[1].body,
      {},
      "({blendBadgeIntoBitmap,renderTrayStatusDotPixels})",
    );
    const ids = new Proxy({}, { get: (_, key) => key });
    const rows = [];
    for (const kind of ["valid-ico", "missing-image", "synthetic-2x"]) {
      const row = { kind, ok: false, trace: [], imageLoads: 0, bitmapBuilds: 0, warnings: 0 };
      try {
        let image;
        if (kind === "synthetic-2x") {
          const raw = Buffer.alloc(64 * 64 * 4);
          for (let at = 0; at < raw.length; at += 4) {
            raw[at] = 40;
            raw[at + 1] = 90;
            raw[at + 2] = 170;
            raw[at + 3] = 255;
          }
          image = nativeImage.createFromBitmap(raw, { width: 64, height: 64, scaleFactor: 2 });
        } else {
          const path = join(config.fixture, kind, "build/icon.ico");
          await assertProjectPath(path);
          image = nativeImage.createFromPath(path);
        }
        row.base = {
          empty: image.isEmpty(),
          size: image.getSize(1),
          scales: image.getScaleFactors(),
        };
        const originalHash = hash(image.toBitmap({ scaleFactor: 1 }));
        const resized = image.resize({ width: 32, height: 32 });
        row.resized = {
          size: resized.getSize(1),
          bytes: resized.toBitmap({ scaleFactor: 1 }).byteLength,
        };
        const images = [],
          tooltips = [],
          menus = [];
        const ports = {
          ...pixels,
          app: { isPackaged: false },
          process: { platform: "win32" },
          join,
          fixtureMainDirectory: join(config.fixture, kind, "app/main"),
          DesktopCommandIds: ids,
          desktopMenuMessageIds: ids,
          getDesktopMenuMessage: (_, id) => id,
          shouldEnableDesktopAutoUpdates: () => false,
          nativeImage: {
            createFromPath(path) {
              assert.equal(path, join(config.fixture, kind, "build/icon.ico"));
              row.imageLoads += 1;
              // 输入是实际 NativeImage；此端口仅为缺失/2x 场景选择真实输入，不模拟图像 API。
              return image;
            },
            createFromBitmap(data, options) {
              row.bitmapBuilds += 1;
              row.build = { bytes: data.byteLength, ...options };
              return nativeImage.createFromBitmap(data, options);
            },
          },
          Menu: { buildFromTemplate: (entries) => entries },
          Tray: class {
            constructor(initial) {
              images.push(initial);
            }
            isDestroyed() {
              return false;
            }
            setImage(next) {
              images.push(next);
            }
            setToolTip(value) {
              tooltips.push(value);
            }
            setContextMenu(menu) {
              menus.push(menu);
            }
            on() {}
          },
        };
        const api = evaluate(
          sources[0].body,
          ports,
          "({createWindowsDesktopTray,syncWindowsDesktopTrayUnread})",
        );
        assert.ok(
          api.createWindowsDesktopTray({
            getLocale: () => "en-US",
            showCurrentWindow() {},
            executeDesktopCommand() {},
            quitApp() {},
            logger: {
              warn() {
                row.warnings += 1;
              },
            },
          }),
        );
        assert.equal(images[0], image);
        row.trace.push(0);
        for (const count of [1, 8, 0, 1]) {
          api.syncWindowsDesktopTrayUnread(count);
          row.trace.push(count);
        }
        assert.equal(row.imageLoads, 1);
        assert.equal(row.warnings, 0);
        assert.equal(
          hash(image.toBitmap({ scaleFactor: 1 })),
          originalHash,
          "BASE_IMAGE_UNCHANGED",
        );
        assert.equal(images[3], image, "CLEAR_RESTORES_BASE");
        assert.deepEqual(tooltips, [
          "trayTooltip",
          "trayTooltip (1 unread tasks)",
          "trayTooltip (8 unread tasks)",
          "trayTooltip",
          "trayTooltip (1 unread tasks)",
        ]);
        assert.equal(menus.length, 5);
        if (kind === "valid-ico") {
          assert.equal(image.isEmpty(), false);
          const badged = images[1];
          assert.notEqual(badged, image);
          assert.equal(images[2], badged, "MULTI_UNREAD_USES_CACHE");
          assert.equal(images[4], badged, "AFTER_CLEAR_USES_VALID_CACHE");
          assert.equal(row.bitmapBuilds, 1);
          const data = badged.toBitmap({ scaleFactor: 1 });
          assert.equal(data.byteLength, 4096);
          assert.deepEqual(badged.getSize(1), { width: 32, height: 32 });
          row.dot = Array.from(data.subarray((27 * 32 + 27) * 4, (27 * 32 + 27) * 4 + 4));
          assert.deepEqual(row.dot, [53, 57, 229, 255], "ACTUAL_RED_DOT_BGRA");
          assert.deepEqual(
            data.subarray(0, 4),
            resized.toBitmap({ scaleFactor: 1 }).subarray(0, 4),
            "PIXEL_OUTSIDE_BADGE_UNCHANGED",
          );
        } else {
          if (kind === "missing-image") assert.equal(image.isEmpty(), true);
          else assert.deepEqual(image.getScaleFactors(), [2]);
          assert.equal(row.bitmapBuilds, 0, "INVALID_BITMAP_MUST_NOT_BE_CONSTRUCTED_OR_CACHED");
          assert.ok(
            images.every((next) => next === image),
            "KEEP_REAL_BASE_FALLBACK",
          );
        }
        row.ok = true;
      } catch (error) {
        Object.assign(row, classify(error));
      }
      rows.push(row);
    }
    assert.equal(BrowserWindow.getAllWindows().length, 0, "NO_NATIVE_WINDOW");
    await writeFile(
      config.resultPath,
      JSON.stringify(
        {
          versions: { electron: process.versions.electron, node: process.versions.node },
          appPathsVerified: true,
          browserWindows: 0,
          sourceMode: config.sourceMode,
          sources: sources.map(({ file, sha256 }) => ({ file, sha256 })),
          rows,
        },
        null,
        2,
      ),
    );
    app.exit(rows.every((row) => row.ok) ? 0 : 1);
  } catch (error) {
    await writeFile(
      config.resultPath,
      JSON.stringify({ failed: true, ...classify(error) }, null, 2),
    );
    app.exit(1);
  }
}

async function runBatch() {
  assert.equal(process.version, "v24.14.0", "PINNED_NODE_REQUIRED");
  assert.equal(process.platform, "win32", "WINDOWS_NATIVEIMAGE_REQUIRED");
  const sandbox = await createProjectTestSandbox("windows-ui-tray-image");
  const fixture = await assertProjectPath(join(sandbox.root, "fixture"));
  const appPaths = {
    home: sandbox.home,
    appData: sandbox.appData,
    temp: sandbox.temp,
    logs: sandbox.logs,
    userData: join(sandbox.data, "electron-user"),
    sessionData: join(sandbox.data, "electron-session"),
    crashDumps: join(sandbox.data, "crash-dumps"),
    ...Object.fromEntries(
      ["desktop", "documents", "downloads", "music", "pictures", "videos", "recent"].map((name) => [
        name,
        join(sandbox.home, name),
      ]),
    ),
  };
  const fixtureDirectories = ["valid-ico", "missing-image", "synthetic-2x"].flatMap((kind) => [
    join(fixture, kind, "build"),
    join(fixture, kind, "app/main"),
  ]);
  for (const path of [...Object.values(appPaths), ...fixtureDirectories]) {
    await mkdir(await assertProjectPath(path), { recursive: true });
    await assertProjectPath(path);
  }
  const sourceIcon = await assertProjectPath(join(projectRoot, "packages/desktop/build/icon.ico"));
  await copyFile(sourceIcon, await assertProjectPath(join(fixture, "valid-ico/build/icon.ico")));
  const sources = await Promise.all(sourceFiles.map(compileSource));
  const bodyPath = await assertProjectPath(join(sandbox.root, "actual-source.json"));
  const resultPath = await assertProjectPath(join(sandbox.root, "results.json"));
  const entry = await assertProjectPath(join(sandbox.root, "electron-batch.cjs"));
  const binary = await assertProjectPath(
    await realpath(join(projectRoot, "node_modules/electron/dist/electron.exe")),
  );
  await access(binary);
  await writeFile(bodyPath, JSON.stringify(sources));
  await writeFile(entry, `void (${electronBatch.toString()})();\n`);
  const env = {
    ...sandbox.env,
    WINUI_TRAY_BATCH_CONFIG: JSON.stringify({
      sourceMode,
      fixture,
      appPaths,
      bodyPath,
      resultPath,
      sandboxHelper: await assertProjectPath(
        join(projectRoot, "scripts/ci/project-test-sandbox.mjs"),
      ),
    }),
  };
  env.HOMEDRIVE = parse(sandbox.home).root.replace(/[\\/]$/u, "");
  env.HOMEPATH = sandbox.home.slice(env.HOMEDRIVE.length);
  // Electron 不接受 Node permission flags；其环境与所有 app 写入目录均先固定在本轮 sandbox。
  for (const key of Object.keys(env)) {
    if (/^(?:node_options|electron_run_as_node|electron_override_dist_path)$/iu.test(key))
      delete env[key];
  }
  const args = [
    entry,
    "--disable-gpu",
    "--disable-background-networking",
    "--disable-breakpad",
    "--disable-component-update",
    "--disable-sync",
    "--disable-domain-reliability",
    `--user-data-dir=${appPaths.userData}`,
    `--disk-cache-dir=${sandbox.cache}`,
    `--crash-dumps-dir=${appPaths.crashDumps}`,
  ];
  await writeFile(
    join(sandbox.root, "launch-plan.json"),
    JSON.stringify(
      {
        launcherNode: process.version,
        sourceMode,
        binary,
        args,
        cwd: sandbox.root,
        appPaths,
        environmentRoots: Object.fromEntries(
          ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"].map((name) => [
            name,
            env[name],
          ]),
        ),
        sourceHashes: sources.map(({ file, sha256 }) => ({ file, sha256 })),
        iconSha256: digest(await readFile(sourceIcon)),
        nativeProcesses: 1,
      },
      null,
      2,
    ),
  );
  const child = spawn(binary, args, {
    cwd: sandbox.root,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdoutBytes = 0,
    stderrBytes = 0,
    expired = false;
  child.stdout.on("data", (data) => {
    stdoutBytes += data.byteLength;
  });
  child.stderr.on("data", (data) => {
    stderrBytes += data.byteLength;
  });
  // 仅限制自有 probe 进程寿命，不参与托盘算法、不保活或延长产品等待。
  const deadline = setTimeout(() => {
    expired = true;
    child.kill();
  }, 30000);
  const completion = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: null, errorCode: error.code ?? error.name }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(deadline);
  await writeFile(
    join(sandbox.root, "completion.json"),
    JSON.stringify(
      {
        ...completion,
        expired,
        stdoutBytes,
        stderrBytes,
      },
      null,
      2,
    ),
  );
  assert.equal(expired, false, "PROBE_DEADLINE_EXCEEDED");
  let report;
  try {
    report = JSON.parse(await readFile(resultPath, "utf8"));
  } catch {
    throw new Error("NATIVE_REPORT_UNAVAILABLE");
  }
  assert.equal(report.failed, undefined, report.code ?? "NATIVE_BOOTSTRAP_FAILED");
  assert.equal(
    completion.code,
    report.rows.every((row) => row.ok) ? 0 : 1,
    "NATIVE_EXIT_MATCHES_RESULTS",
  );
  console.log(`Tray source results: ${resultPath}`);
  console.log(
    JSON.stringify({
      sourceMode,
      versions: report.versions,
      completion,
      rows: report.rows.map(({ kind, ok, code, type, trace, bitmapBuilds }) => ({
        kind,
        ok,
        code,
        type,
        trace,
        bitmapBuilds,
      })),
    }),
  );
  return report;
}

let batch;
for (const kind of ["valid-ico", "missing-image", "synthetic-2x"]) {
  test(`WINUI22 ${kind}: real NativeImage 0→1→many→0→1`, async () => {
    batch ??= runBatch();
    const report = await batch;
    assert.equal(report.appPathsVerified, true);
    const row = report.rows.find((candidate) => candidate.kind === kind);
    assert.equal(row?.ok, true, `${kind}: ${row?.code ?? "ROW_MISSING"}/${row?.type ?? "none"}`);
  });
}
