// 默认配置装载会迁移写回；测试必须先隔离实际进程 HOME，不能只注入 options.env。

import assert from "node:assert/strict";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createSessionId, createProjectId } from "@zcode/contracts";
import { createConfig, resolveWorkspaceStorageDir } from "../src/config/config-factory.js";
import { resolveSourceDataRoots } from "@zcode/shared/node";
import { openStartupSqliteSessionStore } from "@zcode/adapters/storage";
import { createProjectTestFixture } from "../../../../../scripts/ci/project-test-sandbox.mjs";

test("public startup cancellation creates no Source directory or database", async (t) => {
  const temp = await fixture(t);
  const roots = resolveSourceDataRoots(join(temp, "cancelled-source"));
  const controller = new AbortController();
  const reason = new Error("fixture cancelled before public startup");
  controller.abort(reason);
  await assert.rejects(
    async () => openStartupSqliteSessionStore(
      { dbPath: roots.sessionDatabasePath },
      { signal: controller.signal },
    ),
    (error: unknown) => error === reason,
  );
  assert.equal(await statSafe(roots.serverRoot), undefined);
});

// Windows 上 DevicePath/状态目录等系统环境变量可能包含 ZCODE_ 前缀键之外的持久化别名；
// 测试只注入显式字典，不读 process.env，保持断言确定性。
function hostilePersistenceEnv(serverRoot: string, temp: string) {
  return {
    ZCODE_SERVER_ROOT: serverRoot,
    // 敌意继承的 Desktop/旧 aliases，全部必须被 Source 值覆盖
    ZCODE_DATA_BASE_DIR: join(temp, "hijack-data"),
    ZCODE_STORAGE_DIR: join(temp, "hijack-storage"),
    zcode_storage_dir: join(temp, "hijack-storage-lower"),
    ZCODE_SESSION_DB_PATH: join(temp, "hijack-session.sqlite"),
    ZCODE_SESSION_DB: join(temp, "hijack-session-alias.sqlite"),
    zcode_session_db_path: join(temp, "hijack-session-lower.sqlite"),
    // 敌意 user/project/config 层 storage override
    // （env 层经由 parseEnvConfig 已包含 ZCODE_STORAGE_DIR / ZCODE_SESSION_DB_PATH）
    HOME: join(temp, "home"),
    USERPROFILE: join(temp, "home"),
    ZCODE_DESKTOP_HOME_DIR: join(temp, "desktop-home"),
  };
}

async function fixture(t: import("node:test").TestContext) {
  const temp = await createProjectTestFixture("cli-source-roots");
  const home = join(temp, "process-home");
  await mkdir(home);
  const keys = ["HOME", "USERPROFILE", "ZCODE_DESKTOP_HOME_DIR"] as const;
  const previous = keys.map((key) => [key, process.env[key]] as const);
  t.after(async () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const key of keys) process.env[key] = home;
  assert.equal(homedir(), home, "default config must resolve inside the fixture home");
  return temp;
}

test("marker off: plain CLI keeps HOME default and explicit overrides", async (t) => {
  const temp = await fixture(t);
  const home = join(temp, "home");
  const config = createConfig({
    env: { HOME: home, USERPROFILE: home },
    cliOverrides: { storage: { dir: join(temp, "plain-override") } },
  });
  assert.equal(config.config.storage.dir, join(temp, "plain-override"));
  // 显式 user config 指向项目内 fixture，不读真实用户 ~；marker off 时路径契约完全由调用方控制
  const plainUserConfig = join(temp, "plain-user-config.json");
  await writeFile(plainUserConfig, JSON.stringify({ ui: { locale: "en-US" } }));
  const plain = createConfig({
    env: { HOME: home, USERPROFILE: home },
    userConfigPath: plainUserConfig,
  });
  // 非 Source 普通 CLI 默认仍是既有 home 契约（未展开的 ~/.zcodium/...，由 resolvePath 消费方展开）
  assert.equal(plain.config.storage.dir, "~/.zcodium");
  assert.equal(plain.config.storage.sessionDbPath, "~/.zcodium/cli/db/db.sqlite");
  assert.equal(plain.config.ui.locale, "en-US");
  // DATA_BASE_DIR 是 Services 侧概念，不成为普通 CLI config 的新全局默认
  const dataBaseOverride = createConfig({
    env: { HOME: home, USERPROFILE: home, ZCODE_DATA_BASE_DIR: join(temp, "data-base") },
    userConfigPath: plainUserConfig,
  });
  assert.equal(dataBaseOverride.config.storage.dir, "~/.zcodium");
  assert.equal(dataBaseOverride.config.storage.sessionDbPath, "~/.zcodium/cli/db/db.sqlite");
  // skipUserConfig 时不读任何用户文件；既有契约：默认路径来自 homedir()（不消费注入 env
  // 的 HOME），这里只断言 Desktop home 契约形状与未加载，不写机器相关前缀
  const skipped = createConfig({
    env: { HOME: home, USERPROFILE: home },
    skipUserConfig: true,
  });
  assert.equal(skipped.sources.user.loaded, false);
  assert.ok(
    skipped.sources.user.path.endsWith(join(".zcodium", "cli", "config.json")),
    "skipUserConfig default path must keep Desktop home contract shape",
  );
  // 环境变量覆盖契约不变
  const envOverride = createConfig({
    env: {
      HOME: home,
      USERPROFILE: home,
      ZCODE_STORAGE_DIR: join(temp, "env-storage"),
      ZCODE_SESSION_DB_PATH: join(temp, "env-session.sqlite"),
    },
    userConfigPath: plainUserConfig,
  });
  assert.equal(envOverride.config.storage.dir, join(temp, "env-storage"));
  assert.equal(envOverride.config.storage.sessionDbPath, join(temp, "env-session.sqlite"));
});

test("marker on: storage/session fixed to Source roots after default/user/project/env/CLI merge", async (t) => {
  const temp = await fixture(t);
  const rootA = join(temp, "source-a");
  const rootB = join(temp, "source-b");
  const rootsA = resolveSourceDataRoots(rootA);
  const rootsB = resolveSourceDataRoots(rootB);
  assert.notEqual(rootsA.storageDir, rootsB.storageDir);
  assert.notEqual(rootsA.sessionDatabasePath, rootsB.sessionDatabasePath);
  assert.notEqual(rootsA.cliConfigFile, rootsB.cliConfigFile);

  for (const [root, roots] of [
    [rootA, rootsA],
    [rootB, rootsB],
  ] as const) {
    const env = hostilePersistenceEnv(root, temp);
    const result = createConfig({
      env,
      cliOverrides: {
        storage: {
          dir: join(temp, "cli-storage-override"),
          sessionDbPath: join(temp, "cli-session-override.sqlite"),
        },
      },
    });
    assert.equal(result.config.storage.dir, roots.storageDir);
    assert.equal(result.config.storage.sessionDbPath, roots.sessionDatabasePath);
    // 非 persistence 字段仍按原优先级：CLI > env > ... 覆盖生效
  }

  // 非 persistence 字段优先级保持：env 的 network timeout 被 CLI 覆盖
  const result = createConfig({
    env: {
      ...hostilePersistenceEnv(rootA, temp),
      ZCODE_HTTP_TIMEOUT: "12345",
    },
    cliOverrides: { network: { timeout: 999 } },
  });
  assert.equal(result.config.network.timeout, 999);
});

test("marker on: default user config read from cliConfigFile, hostile user/project storage cannot escape", async (t) => {
  const temp = await fixture(t);
  const root = join(temp, "source");
  const roots = resolveSourceDataRoots(root);
  await mkdir(dirname(roots.cliConfigFile), { recursive: true });
  // Source CLI config 文件里敌意写入 storage override + 一个 ui.locale（非 persistence 字段应生效）
  await writeFile(
    roots.cliConfigFile,
    JSON.stringify({
      storage: { dir: join(temp, "escape-via-user-config") },
      ui: { locale: "zh-CN" },
    }),
  );
  const projectDir = join(temp, "workspace");
  await mkdir(projectDir, { recursive: true });
  const projectConfigPath = join(projectDir, "zcodium.config.json");
  await writeFile(
    projectConfigPath,
    JSON.stringify({ storage: { dir: join(temp, "escape-via-project") } }),
  );

  const result = createConfig({
    env: hostilePersistenceEnv(root, temp),
    projectConfigPath,
    workingDirectory: projectDir,
  });
  assert.equal(result.config.storage.dir, roots.storageDir);
  assert.equal(result.config.storage.sessionDbPath, roots.sessionDatabasePath);
  // 默认 user config 确实读的是 cliConfigFile：非 persistence 字段来自该文件
  assert.equal(result.config.ui.locale, "zh-CN");
  assert.equal(result.sources.user.loaded, true);
  assert.equal(result.sources.user.path, roots.cliConfigFile);
});

test("marker on: explicit userConfigPath equal to cliConfigFile is honored, other in-Source paths rejected", async (t) => {
  const temp = await fixture(t);
  const root = join(temp, "source");
  const roots = resolveSourceDataRoots(root);
  await mkdir(dirname(roots.cliConfigFile), { recursive: true });
  await writeFile(roots.cliConfigFile, JSON.stringify({ ui: { locale: "zh-CN" } }));

  // Source 内唯一的合法显式 user config 就是 Source 拥有的 cliConfigFile
  const result = createConfig({
    env: hostilePersistenceEnv(root, temp),
    userConfigPath: roots.cliConfigFile,
  });
  assert.equal(result.sources.user.path, roots.cliConfigFile);
  assert.equal(result.config.ui.locale, "zh-CN");
  assert.equal(result.config.storage.dir, roots.storageDir);

  // Source 存储内的其他路径同样不是 Source config owner：拒绝且不读取
  const insideStorage = join(roots.storageDir, "cli", "explicit.json");
  await writeFile(insideStorage, JSON.stringify({ ui: { locale: "en-US" } }));
  assert.throws(
    () =>
      createConfig({
        env: hostilePersistenceEnv(root, temp),
        userConfigPath: insideStorage,
      }),
    /Source persistence is active: config path rejected/,
  );
  assert.equal(await readFile(insideStorage, "utf-8"), JSON.stringify({ ui: { locale: "en-US" } }));
});

test("marker on: explicit illegal userConfigPath rejected before any read/write (sentinel bytes unchanged)", async (t) => {
  const temp = await fixture(t);
  const root = join(temp, "source");
  const outside = join(temp, "outside");
  await mkdir(outside, { recursive: true });
  const illegalAbsolute = join(outside, "user-config.json");
  const sentinel = '{"sentinel":"untouched"}';
  await writeFile(illegalAbsolute, sentinel);
  const illegalRelative = "relative-user-config.json";

  for (const userConfigPath of [illegalAbsolute, illegalRelative]) {
    assert.throws(
      () =>
        createConfig({
          env: hostilePersistenceEnv(root, temp),
          userConfigPath,
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        // 稳定错误码，不泄露真实路径
        assert.ok(!error.message.includes(illegalAbsolute));
        assert.ok(!error.message.includes(outside));
        assert.ok(error.message.length > 0);
        return true;
      },
    );
  }

  // 字节不变只证明此处未写；读取前的拒绝边界由生产校验顺序保证。
  assert.equal(await readFile(illegalAbsolute, "utf-8"), sentinel);
  // 目录里没有产生迁移临时文件
  const entries = await readdir(outside);
  assert.deepEqual(entries.sort(), ["user-config.json"]);
  // 相对路径也不应在 cwd 附近产生文件
  assert.equal(await statSafe(join(process.cwd(), illegalRelative)), undefined);

  // skipUserConfig 也不能让显式非法路径静默通过
  assert.throws(() =>
    createConfig({
      env: hostilePersistenceEnv(root, temp),
      userConfigPath: illegalAbsolute,
      skipUserConfig: true,
    }),
  );
  assert.equal(await readFile(illegalAbsolute, "utf-8"), sentinel);
});

test("marker on: hostile explicit projectConfigPath not read into persistence; userConfigPath still guarded", async (t) => {
  const temp = await fixture(t);
  const root = join(temp, "source");
  const roots = resolveSourceDataRoots(root);
  const outside = join(temp, "outside");
  await mkdir(outside, { recursive: true });
  const outsideAbsolute = join(outside, "project-config.json");
  const sentinel = '{"sentinel":"untouched"}';
  await writeFile(outsideAbsolute, sentinel);
  await mkdir(dirname(roots.cliConfigFile), { recursive: true });
  const insideAbsolute = join(roots.storageDir, "cli", "project-config.json");
  await writeFile(insideAbsolute, sentinel);

  // project config 属于 workspace 内容而非 persistence authority：Source 分支允许读取
  // （Source Agent 在用户 workspace 内的既有输入合同），但 storage 覆盖由 merge 后的
  // Source 固定值兜底；这里验证敌意 project config 的 storage 写不进结果、文件不被改动。
  for (const projectConfigPath of [outsideAbsolute, insideAbsolute]) {
    const result = createConfig({
      env: hostilePersistenceEnv(root, temp),
      projectConfigPath,
      workingDirectory: join(temp, "workspace"),
    });
    assert.equal(result.config.storage.dir, roots.storageDir);
    assert.equal(result.config.storage.sessionDbPath, roots.sessionDatabasePath);
    assert.equal(await readFile(projectConfigPath, "utf-8"), sentinel);
  }
  assert.deepEqual((await readdir(outside)).sort(), ["project-config.json"]);

  // 对照：userConfigPath 是 persistence authority，同类非法显式路径在读取前拒绝
  assert.throws(
    () =>
      createConfig({
        env: hostilePersistenceEnv(root, temp),
        userConfigPath: outsideAbsolute,
      }),
    /Source persistence is active: config path rejected/,
  );
});

test("marker on: illegal marker values fail closed with stable error, no path leak", async (t) => {
  const temp = await fixture(t);
  for (const marker of ["", "   ", "relative-root", "with\0nul"]) {
    assert.throws(
      () => createConfig({ env: { ZCODE_SERVER_ROOT: marker, HOME: temp, USERPROFILE: temp } }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        // 非空非法值不得回显；空值本身没有可泄路径，只要求稳定拒绝
        if (marker.trim().length > 0) assert.ok(!error.message.includes(marker));
        assert.ok(error.message.length > 0);
        return true;
      },
    );
  }
});

test("marker on/off: resolveWorkspaceStorageDir honors Source fixed root and plain env override", async (t) => {
  const temp = await fixture(t);
  const root = join(temp, "source");
  const roots = resolveSourceDataRoots(root);
  // Source 分支：env/project 层不能改变结果
  assert.equal(
    resolveWorkspaceStorageDir({
      env: {
        ...hostilePersistenceEnv(root, temp),
        ZCODE_STORAGE_DIR: join(temp, "hijack"),
      },
      workingDirectory: temp,
    }),
    roots.storageDir,
  );
  // 普通 CLI：既有 env > project > base 契约不变
  const home = join(temp, "home");
  assert.equal(
    resolveWorkspaceStorageDir({
      env: { HOME: home, USERPROFILE: home, ZCODE_STORAGE_DIR: join(temp, "plain-env") },
      workingDirectory: temp,
    }),
    join(temp, "plain-env"),
  );
});

test("marker on: real project-fixture SQLite session store per Source root, reopen and isolation", async (t) => {
  const temp = await fixture(t);
  const rootA = join(temp, "source-a");
  const rootB = join(temp, "source-b");
  const rootsA = resolveSourceDataRoots(rootA);
  const rootsB = resolveSourceDataRoots(rootB);

  const configA = createConfig({ env: hostilePersistenceEnv(rootA, temp) });
  const configB = createConfig({ env: hostilePersistenceEnv(rootB, temp) });
  assert.equal(configA.config.storage.sessionDbPath, rootsA.sessionDatabasePath);
  assert.equal(configB.config.storage.sessionDbPath, rootsB.sessionDatabasePath);

  // 真实 SQLite：A 建会话 → 关闭 → 重开可见；B 打开看不到 A 的会话
  const storeA1 = await openStartupSqliteSessionStore({
    dbPath: configA.config.storage.sessionDbPath,
  });
  try {
    await storeA1.createSession({
      id: createSessionId("session-a-1"),
      projectID: createProjectId("project-a"),
      slug: "root-a-session",
      directory: temp,
      title: "root A session",
      version: "3.16.2",
    });
  } finally {
    storeA1.close();
  }

  const storeA2 = await openStartupSqliteSessionStore({
    dbPath: configA.config.storage.sessionDbPath,
  });
  try {
    const reopened = await storeA2.listSessions({ roots: true });
    assert.equal(reopened.length, 1);
    assert.equal(reopened[0]?.id, createSessionId("session-a-1"));
  } finally {
    storeA2.close();
  }

  const storeB = await openStartupSqliteSessionStore({
    dbPath: configB.config.storage.sessionDbPath,
  });
  try {
    const isolated = await storeB.listSessions({ roots: true });
    assert.deepEqual(isolated, []);
  } finally {
    storeB.close();
  }

  // 实际落盘位置在各自 Source 根内
  await stat(rootsA.sessionDatabasePath);
  await stat(rootsB.sessionDatabasePath);
  assert.ok(rootsA.sessionDatabasePath.startsWith(rootsA.storageDir));
  assert.ok(rootsB.sessionDatabasePath.startsWith(rootsB.storageDir));
});

test("HOME default resolution uses the isolated process home", async (t) => {
  const temp = await fixture(t);
  const home = join(temp, "process-home");
  assert.equal(homedir(), home);
  const result = createConfig({ env: {} });
  assert.equal(result.sources.user.path, join(home, ".zcodium", "cli", "config.json"));
  assert.equal(result.sources.user.loaded, false);
  assert.deepEqual(await readdir(home), []);
});

async function statSafe(path: string): Promise<import("node:fs").Stats | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
