import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { tsImport } from "tsx/esm/api";
import ts from "typescript";
import { build } from "esbuild";
import {
  assertProjectPath,
  createProjectTestSandbox,
  projectRoot,
} from "./project-test-sandbox.mjs";

const load = (relative) =>
  tsImport(pathToFileURL(join(projectRoot, relative)).href, import.meta.url);
const { ZCODE_USER_DATA_DIR_NAME, ZCODE_APP_CONFIG_SUBDIR_NAME } = await load(
  "packages/shared/src/appDirNames.ts",
);
const { createSystemCredentialCipher } = await load(
  "packages/shared/src/credential-security/systemCredentialCipher.ts",
);
const { copyDataDirectory } = await load("packages/services/src/paths.ts");

test("Main 为复制后的本仓凭据登记密钥，冷恢复可解密且重复登记幂等", async () => {
  const sandbox = await createProjectTestSandbox("fork-credential-root");
  const from = await assertProjectPath(join(sandbox.root, "source"));
  const to = await assertProjectPath(join(sandbox.root, "target"));
  const sourceFile = await assertProjectPath(join(from, ".zcodium/v2/credentials.json"));
  const targetFile = await assertProjectPath(join(to, ".zcodium/v2/credentials.json"));
  await mkdir(dirname(sourceFile), { recursive: true });
  const memoryStore = () => {
    let value = null;
    return {
      async get() {
        return value;
      },
      async set(next) {
        value = next;
      },
    };
  };
  const sourceStore = memoryStore(),
    targetStore = memoryStore();
  const owner = createSystemCredentialCipher({
    filePath: sourceFile,
    keyStore: sourceStore,
    env: {},
  });
  const ciphertext = await owner.encrypt("synthetic-fixture-value");
  await writeFile(sourceFile, JSON.stringify({ fixture: ciphertext }));
  await copyDataDirectory(from, to);
  const target = createSystemCredentialCipher({
    filePath: targetFile,
    keyStore: { get: targetStore.get, set: targetStore.set },
    env: {},
  });
  await assert.rejects(target.decrypt(ciphertext));

  // 提取当前 Main 的真实分支，替身仅替换系统库；路径计算和回包顺序均保留。
  const source = await readFile(
    join(projectRoot, "packages/desktop/src/main/desktopHostProcess.ts"),
    "utf8",
  );
  const parsed = ts.createSourceFile("host.ts", source, ts.ScriptTarget.Latest, true);
  let branch;
  function visit(node) {
    if (
      ts.isIfStatement(node) &&
      node.expression.getText(parsed) ===
        "result.data.type === HostResponseTypes.CredentialKeyShareRequest"
    )
      branch = node;
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert(branch);
  const entry = await assertProjectPath(join(sandbox.root, "main-route.mjs"));
  const moduleSource = `import { isAbsolute, join } from 'node:path';
const ZCODE_USER_DATA_DIR_NAME = ${JSON.stringify(ZCODE_USER_DATA_DIR_NAME)};
const ZCODE_APP_CONFIG_SUBDIR_NAME = ${JSON.stringify(ZCODE_APP_CONFIG_SUBDIR_NAME)};
export function route(result, credentialCipher, child) {
const HostResponseTypes = { CredentialKeyShareRequest: 'credential-key-share-request' };
const HostMessageTypes = { CredentialKeyShareResult: 'credential-key-share-result' };
const CREDENTIAL_KEY_SHARE_UNAVAILABLE_ERROR_CODE = 'CREDENTIAL_SECURE_STORAGE_UNAVAILABLE';
const exitedHostProcesses = new WeakSet(); const dependencies = {logger:{info(){}}};
${branch.getText(parsed)}
}`;
  await writeFile(
    entry,
    ts.transpileModule(moduleSource, {
      compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext },
    }).outputText,
  );
  const { route } = await import(pathToFileURL(entry).href);
  for (let repeat = 0; repeat < 2; repeat++) {
    const reply = await new Promise((resolve) =>
      route(
        { data: { type: "credential-key-share-request", targetBaseDir: to, requestId: "fixture" } },
        {
          shareKeyWithCopiedCredentials(path) {
            return owner.shareKeyWithCopiedCredentials(path, targetStore);
          },
        },
        { postMessage: resolve },
      ),
    );
    assert.equal(reply.ok, true);
    assert.notEqual(await targetStore.get(), null, "复制的凭据应在正确目标路径获得密钥登记");
  }
  // 失败结果按进程缓存，冷恢复使用新的注入 store 包装同一条目。
  const cold = createSystemCredentialCipher({
    filePath: targetFile,
    keyStore: { get: targetStore.get, set: targetStore.set },
    env: {},
  });
  assert.equal(await cold.decrypt(ciphertext), "synthetic-fixture-value");
  await assert.rejects(stat(join(to, ".zcode")), { code: "ENOENT" });
});

test("冷启动语言只读本仓 bootstrap 设置，显式文件覆盖保持", async () => {
  const sandbox = await createProjectTestSandbox("fork-bootstrap-locale");
  for (const [root, uiLocale] of [
    [".zcode", "ja-JP"],
    [".zcodium", "en-US"],
  ]) {
    const path = await assertProjectPath(join(sandbox.home, root, "v2/setting.json"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ uiLocale }));
  }
  const { resolveApplicationLocaleBootstrapSettingsFile, readBootstrapApplicationLocale } =
    await load("packages/desktop/src/main/desktopApplicationLocaleBootstrap.ts");
  const actual = resolveApplicationLocaleBootstrapSettingsFile(sandbox.home);
  assert.equal(readBootstrapApplicationLocale(actual), "en-US");
  assert.equal(
    readBootstrapApplicationLocale(join(sandbox.home, ".zcode/v2/setting.json")),
    "ja-JP",
  );
});

test("首次使用证据默认读取本仓 CLI 库和用户配置，显式环境及未知相对路径保持", async () => {
  const sandbox = await createProjectTestSandbox("fork-usage-evidence");
  const { resolveAgentSessionDbPath, hasAnyAgentSessionRow } = await load(
    "packages/services/src/onboarding/localUsageEvidence.ts",
  );
  const dbPath = await assertProjectPath(join(sandbox.home, ".zcodium/cli/db/db.sqlite"));
  await mkdir(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE session(id TEXT PRIMARY KEY); INSERT INTO session VALUES('fixture')");
  db.close();
  const options = { env: {}, homedirPath: sandbox.home };
  assert.equal(await hasAnyAgentSessionRow(await resolveAgentSessionDbPath(options)), true);
  const customPath = await assertProjectPath(join(sandbox.root, "custom.sqlite"));
  const config = await assertProjectPath(join(sandbox.home, ".zcodium/cli/config.json"));
  await writeFile(config, JSON.stringify({ storage: { sessionDbPath: customPath } }));
  assert.equal(await resolveAgentSessionDbPath(options), customPath);
  assert.equal(
    await resolveAgentSessionDbPath({ ...options, env: { ZCODE_SESSION_DB_PATH: dbPath } }),
    dbPath,
  );
  await writeFile(config, JSON.stringify({ storage: { sessionDbPath: "relative.sqlite" } }));
  assert.equal(await resolveAgentSessionDbPath(options), null);
});

test("默认 alias Repo 合并当前本仓会话库并在同一数据根生成迁移备份", async () => {
  const sandbox = await createProjectTestSandbox("fork-alias-default-root");
  const taskPath = await assertProjectPath(join(sandbox.data, ".zcodium/v2/tasks-index.sqlite"));
  const sessionPath = await assertProjectPath(join(sandbox.data, ".zcodium/cli/db/db.sqlite"));
  await mkdir(dirname(taskPath), { recursive: true });
  await mkdir(dirname(sessionPath), { recursive: true });
  const repoBuild = await build({
    entryPoints: [
      join(
        projectRoot,
        "packages/services/src/source-server-workspace/sourceServerWorkspaceService.ts",
      ),
    ],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    packages: "external",
    plugins: [
      {
        name: "fixture-default-base-owner",
        setup(builder) {
          builder.onResolve({ filter: /^(?:#src\/paths\.js|\.\.\/paths\.js)$/ }, () => ({
            path: "paths",
            namespace: "fixture",
          }));
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: `import {createHash} from 'node:crypto';export const getDataBaseDir=()=>${JSON.stringify(sandbox.data)};export const getTasksIndexDatabasePath=()=>${JSON.stringify(taskPath)};export const getWorkspaceHash=(path,identity)=>createHash('sha256').update(identity?.trim()||path).digest('hex').slice(0,12);`,
          }));
        },
      },
    ],
  });
  const repoModule = await assertProjectPath(join(sandbox.root, "repo.mjs"));
  await writeFile(repoModule, repoBuild.outputFiles[0].contents);
  const { createSourceServerWorkspaceService } = await import(pathToFileURL(repoModule).href);
  const { buildRemoteWorkspaceIdentity } = await load(
    "packages/shared/src/remote-workspace-identity.ts",
  );
  const { runTasksDatabaseMigrations } = await load(
    "packages/services/src/session/tasksDatabase/migrations.ts",
  );
  const { SESSION_DATABASE_MIGRATIONS } = await load(
    "apps/zcode-cli/packages/adapters/src/storage/session-store/migration-contract.ts",
  );
  const { migrate } = await load("packages/shared/src/sqlite-migrations/index.ts");
  const host = new DatabaseSync(taskPath),
    cli = new DatabaseSync(sessionPath);
  try {
    const backups = await assertProjectPath(join(sandbox.root, "fixture-backups"));
    await runTasksDatabaseMigrations(host, "base");
    await runTasksDatabaseMigrations(host, "source-server");
    await migrate(cli, SESSION_DATABASE_MIGRATIONS, {
      database: "cli",
      backupDirectories: [backups],
    });
    const workspace = await assertProjectPath(join(sandbox.root, "workspace"));
    await mkdir(workspace);
    const keys = [
      buildRemoteWorkspaceIdentity(workspace, {
        kind: "ssh",
        host: "fixture",
        port: 22,
        username: "user",
      }),
      buildRemoteWorkspaceIdentity(workspace, { kind: "wsl", distro: "fixture" }),
    ];
    for (const [index, key] of keys.entries()) {
      host
        .prepare(
          "INSERT INTO tasks(workspace_key,workspace_path,workspace_identity,task_id,title,created_at,updated_at) VALUES(?,?,?,?,?,1,1)",
        )
        .run(key, workspace, key, "fixture-" + index, "fixture");
      cli
        .prepare(
          "INSERT INTO session(id,project_id,workspace_id,slug,directory,title,version,time_created,time_updated) VALUES(?,?,?,?,?,?,?,1,1)",
        )
        .run("fixture-" + index, "fixture-project", key, "fixture", workspace, "fixture", "1");
    }
    const repo = createSourceServerWorkspaceService();
    const result = await repo.resolveWorkspace({
      workspacePath: workspace,
      legacyRouteHint: keys[0],
    });
    const rows = cli.prepare("SELECT workspace_id FROM session ORDER BY id").all();
    assert.deepEqual(
      rows.map((row) => row.workspace_id),
      [result.canonicalWorkspaceKey, result.canonicalWorkspaceKey],
    );
    const repeated = await repo.resolveWorkspace({
      workspacePath: workspace,
      legacyRouteHint: keys[0],
    });
    assert.equal(repeated.canonicalWorkspaceKey, result.canonicalWorkspaceKey);
    assert.deepEqual(repeated.mergedKeys, []);
    const entries = await readdir(join(sandbox.data, ".zcodium/server/migration-backups"));
    assert(entries.length > 0);
    await assert.rejects(stat(join(sandbox.data, ".zcode")), { code: "ENOENT" });
  } finally {
    host.close();
    cli.close();
  }
});
