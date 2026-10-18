import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { cleanupPackagedSourcemaps } from "../../packages/desktop/scripts/packaged-sourcemap-cleanup.mjs";
import { replaceAppAsarFromStaging } from "../../packages/desktop/scripts/app-asar-repack.mjs";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const { statFile, uncache } = require("@electron/asar");
const asarCli = join(dirname(require.resolve("@electron/asar/package.json")), "bin/asar.js");
const nativeEntry = "node_modules/native.node";

async function createFixture(t, { maps = false, packFails = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "zcodium-asar-finalize-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resourcesDir = join(root, "resources");
  const appAsarPath = join(resourcesDir, "app.asar");
  const sourceDir = join(root, "source");
  await mkdir(resourcesDir);
  await mkdir(join(sourceDir, "node_modules"), { recursive: true });
  await writeFile(join(sourceDir, "app.js"), "console.log('base');\n");
  await writeFile(join(sourceDir, nativeEntry), "native-content");
  if (maps) {
    await writeFile(join(sourceDir, "old.map"), "{}");
    await writeFile(join(sourceDir, "old.js"), "code\n//# sourceMappingURL=old.map\n");
  }
  await execFileAsync(process.execPath, [
    asarCli,
    "pack",
    sourceDir,
    appAsarPath,
    "--unpack",
    "*.{node,dll,dylib,exe}",
  ]);

  const commands = [];
  const runAsarCommand = (args) => {
    commands.push(args);
    if (packFails && args[0] === "pack") throw new Error("pack failed");
    execFileSync(process.execPath, [asarCli, ...args]);
  };
  return {
    root,
    resourcesDir,
    appAsarPath,
    commands,
    async finalize(prepareStaging = async () => false) {
      await cleanupPackagedSourcemaps({
        appAsarPath,
        resourcesDir,
        runAsarCommand,
        runTimedSync: (_label, run) => run(),
        prepareStaging,
        logger: { log() {} },
        runTimedAsync: (_label, run) => run(),
        replaceAppAsarFromStaging: ({ sourceDir: stagedSource, appAsarPath: targetAsar }) =>
          replaceAppAsarFromStaging({
            sourceDir: stagedSource,
            appAsarPath: targetAsar,
            targetPlatformKey: "win32-x64",
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

async function injectRuntimeModule(stagingDir, { maps = false } = {}) {
  const moduleDir = join(stagingDir, "node_modules", "injected");
  await mkdir(moduleDir, { recursive: true });
  await writeFile(
    join(moduleDir, "index.js"),
    maps ? "module\n//# sourceMappingURL=index.js.map\n" : "module\n",
  );
  if (maps) await writeFile(join(moduleDir, "index.js.map"), "{}");
  return true;
}

test("runtime injection and sourcemap cleanup share one extract/pack and preserve Windows native unpack", async (t) => {
  const fixture = await createFixture(t, { maps: true });
  await fixture.finalize((stagingDir) => injectRuntimeModule(stagingDir, { maps: true }));
  assert.deepEqual(
    fixture.commands.map(([command]) => command),
    ["extract", "pack"],
  );

  const extracted = await fixture.extract();
  assert.equal(await readFile(join(extracted, "old.js"), "utf8"), "code\n");
  assert.equal(
    await readFile(join(extracted, "node_modules/injected/index.js"), "utf8"),
    "module\n",
  );
  for (const map of ["old.map", "node_modules/injected/index.js.map"]) {
    await assert.rejects(access(join(extracted, map)), { code: "ENOENT" });
  }
  uncache(fixture.appAsarPath);
  assert.equal(statFile(fixture.appAsarPath, nativeEntry).unpacked, true);
  assert.equal(
    await readFile(join(`${fixture.appAsarPath}.unpacked`, nativeEntry), "utf8"),
    "native-content",
  );
});

test("unchanged archive keeps its bytes while extra resources still get cleaned", async (t) => {
  const fixture = await createFixture(t);
  const originalArchive = await readFile(fixture.appAsarPath);
  const extraResources = join(fixture.resourcesDir, "web-remote");
  await mkdir(extraResources);
  await writeFile(
    join(extraResources, "mobile.js"),
    "mobile\n//# sourceMappingURL=mobile.js.map\n",
  );
  await writeFile(join(extraResources, "mobile.js.map"), "{}");

  await fixture.finalize();
  assert.deepEqual(
    fixture.commands.map(([command]) => command),
    ["extract"],
  );
  assert.deepEqual(await readFile(fixture.appAsarPath), originalArchive);
  assert.equal(await readFile(join(extraResources, "mobile.js"), "utf8"), "mobile\n");
  await assert.rejects(access(join(extraResources, "mobile.js.map")), { code: "ENOENT" });
});

test("runtime injection without sourcemaps still repacks once", async (t) => {
  const fixture = await createFixture(t);
  await fixture.finalize((stagingDir) => injectRuntimeModule(stagingDir));
  assert.deepEqual(
    fixture.commands.map(([command]) => command),
    ["extract", "pack"],
  );
  assert.equal(
    await readFile(join(await fixture.extract(), "node_modules/injected/index.js"), "utf8"),
    "module\n",
  );
});

test("sourcemap-only changes repack once without runtime preparation", async (t) => {
  const fixture = await createFixture(t, { maps: true });
  await fixture.finalize();
  assert.deepEqual(
    fixture.commands.map(([command]) => command),
    ["extract", "pack"],
  );
  await assert.rejects(access(join(await fixture.extract(), "old.map")), { code: "ENOENT" });
});

test("a staging preparation failure leaves the original archive and native sidecar intact", async (t) => {
  const fixture = await createFixture(t, { maps: true });
  const originalArchive = await readFile(fixture.appAsarPath);
  const originalNative = await readFile(`${fixture.appAsarPath}.unpacked/${nativeEntry}`);
  let stagingPath;

  await assert.rejects(
    fixture.finalize(async (stagingDir) => {
      stagingPath = stagingDir;
      await injectRuntimeModule(stagingDir);
      throw new Error("prepare failed");
    }),
    /prepare failed/,
  );
  assert.deepEqual(
    fixture.commands.map(([command]) => command),
    ["extract"],
  );
  assert.deepEqual(await readFile(fixture.appAsarPath), originalArchive);
  assert.deepEqual(
    await readFile(`${fixture.appAsarPath}.unpacked/${nativeEntry}`),
    originalNative,
  );
  await assert.rejects(access(stagingPath), { code: "ENOENT" });
});

test("sourcemap cleanup failure preserves the archive and removes staging", async (t) => {
  const fixture = await createFixture(t);
  const originalArchive = await readFile(fixture.appAsarPath);
  let stagingPath;

  await assert.rejects(
    fixture.finalize(async (stagingDir) => {
      stagingPath = stagingDir;
      await symlink("missing-target.js", join(stagingDir, "broken.js"));
      return true;
    }),
    { code: "ENOENT" },
  );
  assert.deepEqual(
    fixture.commands.map(([command]) => command),
    ["extract"],
  );
  assert.deepEqual(await readFile(fixture.appAsarPath), originalArchive);
  await assert.rejects(access(stagingPath), { code: "ENOENT" });
});

test("candidate pack failure keeps the original archive and removes candidate files", async (t) => {
  const fixture = await createFixture(t, { maps: true, packFails: true });
  const originalArchive = await readFile(fixture.appAsarPath);

  await assert.rejects(
    fixture.finalize((stagingDir) => injectRuntimeModule(stagingDir)),
    /pack failed/,
  );
  assert.deepEqual(await readFile(fixture.appAsarPath), originalArchive);
  for (const path of [`${fixture.appAsarPath}.next`, `${fixture.appAsarPath}.next.unpacked`]) {
    await assert.rejects(access(path), { code: "ENOENT" });
  }
});
