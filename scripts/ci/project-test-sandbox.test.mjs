import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  assertProjectPath,
  createProjectTestFixture,
  createProjectTestSandbox,
  projectRoot,
  projectValidationRoot,
} from "./project-test-sandbox.mjs";

const run = promisify(execFile);

test("project paths reject outside, root and relative locations before creating anything", async () => {
  const before = await readdir(dirname(projectRoot));
  for (const path of ["", "relative", projectRoot, parse(projectRoot).root, dirname(projectRoot)]) {
    await assert.rejects(assertProjectPath(path), /PROJECT_TEST_PATH_REJECTED/);
  }
  assert.deepEqual(await readdir(dirname(projectRoot)), before);
});

test("sandbox creates fresh project-owned paths and replaces inherited persistence aliases", async () => {
  const first = await createProjectTestSandbox("environment", {
    env: {
      ...process.env,
      HOME: "unused-home",
      USERPROFILE: "unused-profile",
      zcode_storage_dir: "unused-storage",
      ZCODE_SERVER_ROOT: "unused-source",
      ZCODE_SESSION_DB: "unused-session",
      APPDATA: "unused-appdata",
      LOCALAPPDATA: "unused-local-appdata",
      TEMP: "unused-temp",
      TMPDIR: "unused-tmpdir",
      XDG_CONFIG_HOME: "unused-config",
      npm_config_userconfig: "unused-user-config",
      PNPM_HOME: "unused-pnpm-home",
      NODE_COMPILE_CACHE: "unused-compile-cache",
      TURBO_CACHE_DIR: "unused-turbo-cache",
      ZCODE_LOG_DIR: "unused-logs",
      ZCODE_LOCAL_RESOURCE_MONITORING: "1",
      ZCODIUM_UPDATE_ORIGIN: "unused-origin",
    },
  });
  const second = await createProjectTestSandbox("environment");
  assert.notEqual(first.root, second.root);
  assert.equal(first.env.HOME, first.home);
  assert.equal(first.env.USERPROFILE, first.home);
  assert.equal(first.env.ZCODE_DESKTOP_HOME_DIR, first.home);
  assert.equal(first.env.TEMP, first.temp);
  assert.equal(first.env.TMP, first.temp);
  assert.equal(first.env.TMPDIR, first.temp);
  assert.equal(first.env.ZCODE_SERVER_ROOT, undefined);
  assert.equal(first.env.ZCODIUM_UPDATE_ORIGIN, undefined);
  assert.equal(first.env.zcode_storage_dir, undefined);
  assert.equal(first.env.ZCODE_LOCAL_RESOURCE_MONITORING, "0");
  assert.equal(first.env.COREPACK_ENABLE_NETWORK, "0");
  assert.equal(first.env.APPDATA, first.appData);
  assert.equal(first.env.LOCALAPPDATA, first.localAppData);
  assert.equal(first.env.XDG_CONFIG_HOME, first.config);
  assert.equal(first.env.npm_config_userconfig, join(first.config, "npmrc"));
  assert.equal(first.env.PNPM_HOME, join(first.cache, "pnpm"));
  assert.equal(first.env.NODE_COMPILE_CACHE, undefined);
  assert.equal(first.env.NODE_DISABLE_COMPILE_CACHE, "1");
  assert.equal(first.env.TURBO_CACHE_DIR, join(first.cache, "turbo"));
  assert.equal(first.env.ZCODE_LOG_DIR, first.logs);
  for (const path of [first.root, first.home, first.temp, first.env.ZCODE_STORAGE_DIR]) {
    await assertProjectPath(path);
  }
  assert.deepEqual(await readdir(first.home), []);
});

test("sandbox refuses invalid labels and an inherited sandbox outside its dedicated project root", async () => {
  await assert.rejects(createProjectTestSandbox("../escape"), /PROJECT_TEST_PATH_REJECTED/);
  await assert.rejects(
    createProjectTestSandbox("invalid-parent", {
      env: { ...process.env, PROJECT_TEST_SANDBOX_ROOT: dirname(projectRoot) },
    }),
    /PROJECT_TEST_PATH_REJECTED/,
  );
});

test("project path validation rejects junctions including links to another project-owned directory", async () => {
  const sandbox = await createProjectTestSandbox("junction");
  const target = join(sandbox.root, "target");
  const link = join(sandbox.root, "link");
  await mkdir(target);
  await assertProjectPath(link);
  await assertProjectPath(target);
  // Node 的受限写入模式禁止 symlink API；只向原生命令传已验证的两个 fixture 路径。
  if (process.platform === "win32") {
    await run("cmd.exe", ["/d", "/c", "mklink", "/J", link, target], {
      env: sandbox.env,
      windowsHide: true,
    });
  } else {
    await run("/bin/ln", ["-s", target, link], { env: sandbox.env });
  }
  await assert.rejects(assertProjectPath(link), /PROJECT_TEST_PATH_REJECTED/);
  await assert.rejects(assertProjectPath(join(link, "nested")), /PROJECT_TEST_PATH_REJECTED/);
  assert.deepEqual(await readdir(target), []);
});

test("Node child observes only project-bound home, temp and filesystem write permissions", async () => {
  const sandbox = await createProjectTestSandbox("child-boundary");
  const script = `
    const { homedir, tmpdir } = require("node:os");
    process.stdout.write(JSON.stringify({
      home: homedir(), temp: tmpdir(),
      sandboxWrite: process.permission.has("fs.write", process.env.PROJECT_TEST_SANDBOX_ROOT),
      projectWrite: process.permission.has("fs.write", process.argv[1]),
      outsideWrite: process.permission.has("fs.write", process.argv[2])
    }));
  `;
  const { stdout } = await run(
    process.execPath,
    ["-e", script, projectRoot, dirname(projectRoot)],
    {
      cwd: projectRoot,
      env: sandbox.env,
      windowsHide: true,
    },
  );
  assert.deepEqual(JSON.parse(stdout), {
    home: sandbox.home,
    temp: sandbox.temp,
    sandboxWrite: true,
    projectWrite: false,
    outsideWrite: false,
  });
});

test("fixtures require a bound sandbox and remain inside that sandbox without recursive cleanup", async () => {
  const sandbox = await createProjectTestSandbox("fixture");
  const fixture = await createProjectTestFixture("owned", sandbox.env);
  await assertProjectPath(fixture);
  assert.equal(dirname(fixture), join(sandbox.root, "fixtures"));
  assert.deepEqual(await readdir(fixture), []);
  await assert.rejects(createProjectTestFixture("unbound", {}), /PROJECT_TEST_PATH_REJECTED/);
  assert.ok((await readdir(projectValidationRoot)).length > 0);
  const source = await readFile(new URL("./project-test-sandbox.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(?:rm|unlink|rmdir)\s*\(/);
});
