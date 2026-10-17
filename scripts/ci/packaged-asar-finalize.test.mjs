import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { cleanupPackagedSourcemaps } from "../../packages/desktop/scripts/packaged-sourcemap-cleanup.mjs";
import { replaceAppAsarFromStaging } from "../../packages/desktop/scripts/app-asar-repack.mjs";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const { statFile, uncache } = require("@electron/asar");
const asarCli = join(dirname(require.resolve("@electron/asar/package.json")), "bin/asar.js");
const nativeEntry = "node_modules/native.node";

async function fixture(t, { maps = false, packFails = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "zcode-asar-finalize-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appAsarPath = join(root, "resources", "app.asar");
  const resourcesDir = join(root, "resources");
  const initial = join(root, "initial");
  await mkdir(resourcesDir);
  await mkdir(join(initial, "node_modules"), { recursive: true });
  await writeFile(join(initial, "app.js"), "console.log('base');\n");
  await writeFile(join(initial, nativeEntry), "native-content");
  if (maps) {
    await writeFile(join(initial, "old.map"), "{}");
    await writeFile(join(initial, "old.js"), "code\n//# sourceMappingURL=old.map\n");
  }
  await execFileAsync(process.execPath, [
    asarCli,
    "pack",
    initial,
    appAsarPath,
    "--unpack",
    "*.{node,dll,dylib,exe}",
  ]);
  const commands = [];
  const logger = { log() {} };
  const runAsarCommand = (args) => {
    commands.push(args);
    if (packFails && args[0] === "pack") throw new Error("pack failed");
    execFileSync(process.execPath, [asarCli, ...args]);
  };
  return {
    root,
    appAsarPath,
    resourcesDir,
    commands,
    async finalize(prepareStaging = async () => false) {
      await cleanupPackagedSourcemaps({
        appAsarPath,
        resourcesDir,
        runAsarCommand,
        prepareStaging,
        logger,
        runTimedAsync: (_label, fn) => fn(),
        replaceAppAsarFromStaging: ({ sourceDir, appAsarPath }) =>
          replaceAppAsarFromStaging({
            sourceDir,
            appAsarPath,
            targetPlatformKey: "linux-x64",
            runAsarCommand,
          }),
      });
    },
    async extract() {
      const destination = join(root, "verify");
      await execFileAsync(process.execPath, [asarCli, "extract", appAsarPath, destination]);
      return destination;
    },
  };
}

async function inject(staging, { maps = false } = {}) {
  const directory = join(staging, "node_modules", "injected");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "index.js"),
    maps ? "module\n//# sourceMappingURL=index.js.map\n" : "module\n",
  );
  if (maps) await writeFile(join(directory, "index.js.map"), "{}");
  return true;
}

test("runtime injection plus sourcemaps use one extract/repack and preserve native unpack", async (t) => {
  const f = await fixture(t, { maps: true });
  await f.finalize((staging) => inject(staging, { maps: true }));
  assert.deepEqual(
    f.commands.map(([command]) => command),
    ["extract", "pack"],
  );
  const extracted = await f.extract();
  assert.equal(
    await readFile(join(extracted, "node_modules/injected/index.js"), "utf8"),
    "module\n",
  );
  assert.equal(await readFile(join(extracted, "old.js"), "utf8"), "code\n");
  for (const map of ["old.map", "node_modules/injected/index.js.map"]) {
    await assert.rejects(access(join(extracted, map)), { code: "ENOENT" });
  }
  uncache(f.appAsarPath);
  assert.equal(statFile(f.appAsarPath, nativeEntry).unpacked, true);
  assert.equal(
    await readFile(join(`${f.appAsarPath}.unpacked`, nativeEntry), "utf8"),
    "native-content",
  );
});

test("unchanged archive is not repacked and extra resources still get cleaned", async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.appAsarPath);
  const extra = join(f.resourcesDir, "web-remote");
  await mkdir(extra);
  await writeFile(join(extra, "mobile.js"), "mobile\n//# sourceMappingURL=mobile.js.map\n");
  await writeFile(join(extra, "mobile.js.map"), "{}");
  await f.finalize();
  assert.deepEqual(
    f.commands.map(([command]) => command),
    ["extract"],
  );
  assert.deepEqual(await readFile(f.appAsarPath), before);
  assert.equal(await readFile(join(extra, "mobile.js"), "utf8"), "mobile\n");
  await assert.rejects(access(join(extra, "mobile.js.map")), { code: "ENOENT" });
});

test("runtime injection without any sourcemaps still commits once", async (t) => {
  const f = await fixture(t);
  await f.finalize((staging) => inject(staging));
  assert.deepEqual(
    f.commands.map(([command]) => command),
    ["extract", "pack"],
  );
  assert.equal(
    await readFile(join(await f.extract(), "node_modules/injected/index.js"), "utf8"),
    "module\n",
  );
});

test("sourcemap-only change commits once without a runtime preparation callback", async (t) => {
  const f = await fixture(t, { maps: true });
  await f.finalize();
  assert.deepEqual(
    f.commands.map(([command]) => command),
    ["extract", "pack"],
  );
  await assert.rejects(access(join(await f.extract(), "old.map")), { code: "ENOENT" });
});

test("staging preparation failure preserves archive/sidecar and removes staging", async (t) => {
  const f = await fixture(t, { maps: true });
  const before = await readFile(f.appAsarPath);
  const nativeBefore = await readFile(join(`${f.appAsarPath}.unpacked`, nativeEntry));
  let stagingPath;
  await assert.rejects(
    f.finalize(async (staging) => {
      stagingPath = staging;
      await inject(staging);
      throw new Error("prepare failed");
    }),
    /prepare failed/,
  );
  assert.deepEqual(
    f.commands.map(([command]) => command),
    ["extract"],
  );
  assert.deepEqual(await readFile(f.appAsarPath), before);
  assert.deepEqual(await readFile(join(`${f.appAsarPath}.unpacked`, nativeEntry)), nativeBefore);
  await assert.rejects(access(stagingPath), { code: "ENOENT" });
});

test("cleanup failure aborts before replacing the archive and removes staging", async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.appAsarPath);
  let stagingPath;
  await assert.rejects(
    f.finalize(async (staging) => {
      stagingPath = staging;
      await symlink("missing.js", join(staging, "broken.js"));
      return true;
    }),
    { code: "ENOENT" },
  );
  assert.deepEqual(
    f.commands.map(([command]) => command),
    ["extract"],
  );
  assert.deepEqual(await readFile(f.appAsarPath), before);
  await assert.rejects(access(stagingPath), { code: "ENOENT" });
});

test("candidate pack failure preserves the original native sidecar and archive", async (t) => {
  const f = await fixture(t, { maps: true, packFails: true });
  const before = await readFile(f.appAsarPath);
  const nativeBefore = await readFile(join(`${f.appAsarPath}.unpacked`, nativeEntry));
  let stagingPath;
  await assert.rejects(
    f.finalize(async (staging) => {
      stagingPath = staging;
      return inject(staging);
    }),
    /pack failed/,
  );
  assert.deepEqual(await readFile(f.appAsarPath), before);
  assert.deepEqual(await readFile(join(`${f.appAsarPath}.unpacked`, nativeEntry)), nativeBefore);
  for (const path of [stagingPath, `${f.appAsarPath}.next`, `${f.appAsarPath}.next.unpacked`]) {
    await assert.rejects(access(path), { code: "ENOENT" });
  }
});

test("resource links retain the previous sourcemap cleanup behavior", async (t) => {
  const f = await fixture(t);
  const target = join(f.root, "linked.js");
  await writeFile(target, "linked\n//# sourceMappingURL=linked.js.map\n");
  await symlink(target, join(f.resourcesDir, "link.js"));
  await f.finalize();
  assert.equal(await readFile(target, "utf8"), "linked\n");
});
