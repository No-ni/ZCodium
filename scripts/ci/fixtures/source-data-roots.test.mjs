import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createProjectTestFixture } from "../project-test-sandbox.mjs";
import { dirname, join, parse } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { tsImport } from "tsx/esm/api";

const shared = await tsImport("../../../packages/shared/src/node.ts", import.meta.url);
const { resolveServerLayout } = await tsImport(
  "../../../packages/zcode-server-cli/src/runtime/paths.ts",
  import.meta.url,
);
const { createSettingService } = await tsImport(
  "../../../packages/services/src/setting/settingService.ts",
  import.meta.url,
);
const run = promisify(execFile);
async function fixture() {
  return createProjectTestFixture("source-data-roots");
}

test("Source layout has one stable absolute persistence root and rejects ambiguous roots", async (t) => {
  const root = join(await fixture(t), "source");
  assert.equal(typeof shared.resolveSourceDataRoots, "function");
  const paths = shared.resolveSourceDataRoots(root);
  assert.deepEqual(paths, shared.resolveSourceDataRoots(root));
  assert.equal(paths.dataBaseDir, join(root, "data"));
  assert.equal(paths.storageDir, join(root, "data", ".zcodium"));
  assert.equal(paths.dataRoot, paths.storageDir);
  assert.equal(paths.settingsFile, join(paths.configRoot, "setting.json"));
  assert.equal(paths.taskDatabasePath, join(paths.configRoot, "tasks-index.sqlite"));
  assert.equal(paths.sessionDatabasePath, join(paths.storageDir, "cli", "db", "db.sqlite"));
  assert.equal(paths.cliConfigFile, join(paths.storageDir, "cli", "config.json"));
  const layout = resolveServerLayout(root);
  for (const [key, value] of Object.entries(paths)) assert.equal(layout[key], value);
  for (const invalid of ["", " ", "relative", parse(root).root, `${root}\0bad`])
    assert.throws(() => shared.resolveSourceDataRoots(invalid), /Invalid Source server root/);
  assert.notEqual(paths.settingsFile, shared.resolveSourceDataRoots(`${root}-other`).settingsFile);
});

test("Source persistence environment removes casing aliases and survives a real fake Agent spawn", async (t) => {
  const temp = await fixture(t);
  const root = join(temp, "source");
  assert.equal(typeof shared.createSourcePersistenceEnv, "function");
  const hostile = {
    HOME: join(temp, "home"),
    USERPROFILE: join(temp, "profile"),
    ZCODE_DESKTOP_HOME_DIR: join(temp, "desktop"),
    KEEP: "command",
    zcode_server_root: "bad",
    ZCODE_DATA_BASE_DIR: "bad",
    zcode_storage_dir: "bad",
    ZCODE_SESSION_DB: "bad",
    zcode_session_db_path: "bad",
  };
  const env = shared.createSourcePersistenceEnv(root, hostile);
  assert.deepEqual(hostile.zcode_storage_dir, "bad");
  assert.equal(env.zcode_storage_dir, undefined);
  assert.equal(env.zcode_server_root, undefined);
  for (const key of ["HOME", "USERPROFILE", "ZCODE_DESKTOP_HOME_DIR", "KEEP"])
    assert.equal(env[key], hostile[key]);
  const { stdout } = await run(
    process.execPath,
    ["-e", "process.stdout.write(JSON.stringify(process.env))"],
    {
      env: { ...process.env, ...env },
      windowsHide: true,
    },
  );
  const observed = JSON.parse(stdout);
  const paths = shared.resolveSourceDataRoots(root);
  assert.equal(observed.ZCODE_SERVER_ROOT, root);
  assert.equal(observed.ZCODE_DATA_BASE_DIR, paths.dataBaseDir);
  assert.equal(observed.ZCODE_STORAGE_DIR, paths.storageDir);
  assert.equal(observed.ZCODE_SESSION_DB_PATH, paths.sessionDatabasePath);
  assert.equal(observed.ZCODE_SESSION_DB, paths.sessionDatabasePath);
  assert.equal(observed.KEEP, "command");
});

test("Source setting read, migration, writes and restart never touch Desktop bootstrap", async (t) => {
  const temp = await fixture(t);
  const desktop = join(temp, "desktop");
  const old = process.env.ZCODE_DESKTOP_HOME_DIR;
  process.env.ZCODE_DESKTOP_HOME_DIR = desktop;
  t.after(() => {
    if (old === undefined) delete process.env.ZCODE_DESKTOP_HOME_DIR;
    else process.env.ZCODE_DESKTOP_HOME_DIR = old;
  });
  const desktopFile = join(desktop, ".zcodium", "v2", "setting.json");
  await mkdir(dirname(desktopFile), { recursive: true });
  const sentinel = '{"locale":"zh-CN","desktopSentinel":"untouched"}';
  await writeFile(desktopFile, sentinel);
  const options = {
    settingsFilePath: join(temp, "source", "data", ".zcodium", "v2", "setting.json"),
    fixedDataBaseDir: join(temp, "source", "data"),
  };
  await mkdir(dirname(options.settingsFilePath), { recursive: true });
  await writeFile(
    options.settingsFilePath,
    JSON.stringify({ locale: "en-US", dataBaseDir: desktop }),
  );
  const frozen = { ...options };
  const service = createSettingService(options);
  options.settingsFilePath = desktopFile;
  options.fixedDataBaseDir = desktop;
  assert.equal((await service.get()).dataBaseDir, frozen.fixedDataBaseDir);
  assert.equal((await service.get()).locale, "en-US");
  await service.update({ locale: "zh-CN" });
  assert.equal((await createSettingService(frozen).get()).locale, "zh-CN");
  const otherOptions = {
    settingsFilePath: join(temp, "other", "data", ".zcodium", "v2", "setting.json"),
    fixedDataBaseDir: join(temp, "other", "data"),
  };
  const other = createSettingService(otherOptions);
  await other.update({ locale: "en-US" });
  assert.equal((await service.get()).locale, "zh-CN");
  assert.equal((await other.get()).locale, "en-US");
  assert.equal(await readFile(desktopFile, "utf8"), sentinel);
  assert.equal(
    JSON.parse(await readFile(frozen.settingsFilePath, "utf8")).dataBaseDir,
    frozen.fixedDataBaseDir,
  );
});

test("both Source data-root mutation entrances reject before creating files or locks", async (t) => {
  const temp = await fixture(t);
  const old = process.env.ZCODE_DESKTOP_HOME_DIR;
  process.env.ZCODE_DESKTOP_HOME_DIR = join(temp, "desktop");
  t.after(() => {
    if (old === undefined) delete process.env.ZCODE_DESKTOP_HOME_DIR;
    else process.env.ZCODE_DESKTOP_HOME_DIR = old;
  });
  const options = {
    settingsFilePath: join(temp, "absent", "setting.json"),
    fixedDataBaseDir: join(temp, "source", "data"),
  };
  const service = createSettingService(options);
  for (const value of [undefined, options.fixedDataBaseDir, join(temp, "target")]) {
    await assert.rejects(service.update({ dataBaseDir: value }), /SOURCE_DATA_BASE_DIR_FIXED/);
    await assert.rejects(service.updateDataBaseDir(value), /SOURCE_DATA_BASE_DIR_FIXED/);
  }
  assert.deepEqual(await readdir(temp), []);
  assert.throws(
    () => createSettingService({ settingsFilePath: "relative" }),
    /Invalid settings file path/,
  );
});
