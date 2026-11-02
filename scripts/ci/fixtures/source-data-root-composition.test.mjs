import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createProjectTestFixture } from "../project-test-sandbox.mjs";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import ts from "typescript";
import { tsImport } from "tsx/esm/api";

const { resolveSourceDataRoots, createSourcePersistenceEnv, ZCODE_APP_VERSION_ENV, ZCODE_VERSION } =
  await tsImport("../../../packages/shared/src/node.ts", import.meta.url);
const { createSourceAgentCommandResolver } = await tsImport(
  "../../../packages/services/src/runtime-tools/sourceAgentCommand.ts",
  import.meta.url,
);
const { createNodeSourceWorkspaceInspectionService } = await tsImport(
  "../../../packages/services/src/source-server-workspace/node.ts",
  import.meta.url,
);
const { ISourceWorkspaceInspectionService } = await tsImport(
  "../../../packages/services/src/source-server-workspace/index.ts",
  import.meta.url,
);
const { ServiceCollection } = await tsImport(
  "../../../packages/services/src/collection.ts",
  import.meta.url,
);
const run = promisify(execFile);
async function fixture() {
  return createProjectTestFixture("source-composition");
}
async function productionPropertyCallback(path, name, dependencies) {
  const text = await readFile(new URL(`../../../${path}`, import.meta.url), "utf8");
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const matches = [];
  function visit(node) {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(source) === name &&
      ts.isArrowFunction(node.initializer)
    )
      matches.push(node.initializer.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(matches.length, 1, `Expected one production property callback: ${name}`);
  const { outputText } = ts.transpileModule(
    `const callback = ${matches[0].replaceAll("import.meta.url", "fixtureModuleUrl")};`,
    { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } },
  );
  return new Function(...Object.keys(dependencies), `${outputText}; return callback;`)(
    ...Object.values(dependencies),
  );
}
async function productionFunction(path, name, dependencies) {
  const text = await readFile(new URL(`../../../${path}`, import.meta.url), "utf8");
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const matches = source.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  assert.equal(matches.length, 1);
  const { outputText } = ts.transpileModule(matches[0].getText(source).replace(/^export\s+/, ""), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  });
  return new Function(...Object.keys(dependencies), `${outputText}; return ${name};`)(
    ...Object.values(dependencies),
  );
}

test("standalone composition fixes Services roots and refuses another settings authority before initialization IO", async (t) => {
  const temp = await fixture(t);
  const paths = resolveSourceDataRoots(join(temp, "source"));
  const boundary = new Error("fixture initialization boundary");
  const events = [];
  const execute = await productionFunction("packages/services/src/node.ts", "createLocalServices", {
    process: { env: {} },
    resolveSourceDataRoots,
    setDataBaseDir: (value) => events.push(["root", value]),
    initializeRuntimeProcessEnv: () => {
      events.push(["initialize"]);
      throw boundary;
    },
  });
  const options = {
    serviceAuthorityMode: "standalone-server",
    sourceServerRoot: paths.serverRoot,
    zcodeBuiltinProviderConfigFilePath: join(temp, "builtin.json"),
  };
  assert.throws(
    () => execute(options),
    (error) => error === boundary,
  );
  assert.deepEqual(events, [["root", paths.dataBaseDir], ["initialize"]]);
  events.length = 0;
  assert.throws(
    () => execute({ ...options, settingService: {} }),
    /Source settings authority is fixed/,
  );
  assert.throws(
    () => execute({ ...options, sourceServerRoot: "relative" }),
    /Invalid Source server root/,
  );
  assert.deepEqual(events, []);
  assert.deepEqual(await readdir(temp), []);
});

test("Source Agent wrapper pins storage and same-runtime provider files but preserves command and non-persistence precedence", async (t) => {
  const temp = await fixture(t);
  const roots = resolveSourceDataRoots(join(temp, "source"));
  const context = { workspacePath: temp, workspaceKey: "fixture" };
  const command = {
    command: process.execPath,
    args: ["-e", "process.stdout.write(JSON.stringify(process.env))"],
    env: {
      KEEP: "command",
      zcode_storage_dir: "bad",
      ZCODE_SESSION_DB_PATH: "bad",
      ZCODE_DATA_BASE_DIR: "bad",
      zcode_personal_provider_config_file: "bad",
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "bad",
    },
  };
  const providerPaths = {
    personalFilePath: join(roots.providerConfigRoot, "provider_config.json"),
    zcodeBuiltinFilePath: join(roots.configRoot, "builtin.json"),
  };
  const resolver = createSourceAgentCommandResolver({
    roots,
    resolver: (actual) => {
      assert.equal(actual, context);
      return command;
    },
    resolveProviderPaths: async () => providerPaths,
  });
  const resolved = await resolver(context);
  assert.equal(resolved.command, command.command);
  assert.equal(resolved.args, command.args);
  assert.equal(command.env.zcode_storage_dir, "bad");
  const env = createSourcePersistenceEnv(roots.serverRoot, {
    ...process.env,
    KEEP: "inherited",
    ...resolved.env,
  });
  const { stdout } = await run(resolved.command, resolved.args, { env, windowsHide: true });
  const observed = JSON.parse(stdout);
  assert.equal(observed.KEEP, "command");
  assert.equal(observed.ZCODE_STORAGE_DIR, roots.storageDir);
  assert.equal(observed.ZCODE_SESSION_DB_PATH, roots.sessionDatabasePath);
  assert.equal(observed.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, providerPaths.personalFilePath);
  assert.equal(observed.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, providerPaths.zcodeBuiltinFilePath);
  assert.equal(observed.zcode_personal_provider_config_file, undefined);
  assert.equal(
    await createSourceAgentCommandResolver({
      roots,
      resolver: () => null,
      resolveProviderPaths: async () => assert.fail("null command must not read provider"),
    })(context),
    null,
  );
});

test("Core registers inspection with authenticated Source ID and actual layout before HTTP publication", async (t) => {
  const temp = await fixture(t);
  const sourceRoot = join(temp, "source");
  const paths = resolveSourceDataRoots(sourceRoot);
  await mkdir(paths.dataRoot, { recursive: true });
  const services = new ServiceCollection();
  const events = [];
  const boundary = new Error("fixture HTTP publication boundary");
  const scope = { sourceServerId: "fixture-installation", workspacePath: "/fixture" };
  let instance;
  const execute = await productionFunction(
    "packages/zcode-server-cli/src/server-core/core.ts",
    "runServerCore",
    {
      process: { env: { ZCODE_SERVER_ROOT: sourceRoot } },
      ZCODE_APP_VERSION_ENV,
      ZCODE_VERSION,
      createTopicResourcePeers: () => ({
        getChannel() {
          throw new Error("No resource peer in this fixture");
        },
      }),
      join,
      __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__: "{}",
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV: "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
      getAppConfigDir: () => join(temp, "wrong-desktop"),
      resolveServerLayout: (value) => {
        assert.equal(value, sourceRoot);
        events.push("layout");
        return { ...paths, runDir: join(sourceRoot, "run") };
      },
      resolveCoreServerId: async (value) => {
        assert.equal(value, sourceRoot);
        events.push("identity");
        return scope.sourceServerId;
      },
      installParentDisconnectHandler: () => () => {},
      materializeZCodeBuiltinProviderConfig: async (options) => {
        assert.equal(options.environmentConfigRoot, paths.configRoot);
        events.push("builtin");
        return join(paths.configRoot, "builtin.json");
      },
      createLocalServices: (options) => {
        assert.equal(options.sourceServerRoot, sourceRoot);
        events.push("services");
        return services;
      },
      createNodeSourceWorkspaceInspectionService: (options) => {
        assert.equal(options.sourceServerId, scope.sourceServerId);
        for (const key of ["dataRoot", "taskDatabasePath", "sessionDatabasePath"])
          assert.equal(options[key], paths[key]);
        assert.ok(options.configHashRoots.includes(join(paths.configRoot, "sessions")));
        events.push("inspection");
        instance = createNodeSourceWorkspaceInspectionService(options);
        return instance;
      },
      ISourceWorkspaceInspectionService,
      IZCodeAgentService: { channelName: "fixture-agent" },
      createTaskActivityTracker: () => ({ readRunningTaskCount: () => 0 }),
      ensureIngressToken: async (value) => {
        assert.equal(value, join(sourceRoot, "run"));
        return "a".repeat(64);
      },
      createCoreHttpServer: async (actual, options) => {
        assert.equal(actual, services);
        assert.equal(options.serverId, scope.sourceServerId);
        assert.equal(actual.get(ISourceWorkspaceInspectionService), instance);
        events.push("http");
        throw boundary;
      },
    },
  );
  await assert.rejects(execute(1), (error) => error === boundary);
  assert.deepEqual(events, ["layout", "identity", "builtin", "services", "inspection", "http"]);
  assert.equal((await instance.inspect(scope)).state, "clear");
  await mkdir(dirname(paths.sessionDatabasePath), { recursive: true });
  await writeFile(paths.sessionDatabasePath, "fixture never opened as SQLite");
  assert.equal((await instance.inspect(scope)).state, "history-present");
});

test("Core cannot publish a Source inspection capability without verified installation identity", async (t) => {
  const temp = await fixture(t);
  let materializations = 0;
  const execute = await productionFunction(
    "packages/zcode-server-cli/src/server-core/core.ts",
    "runServerCore",
    {
      process: { env: { ZCODE_SERVER_ROOT: join(temp, "source") } },
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV: "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
      __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__: "{}",
      getAppConfigDir: () => join(temp, "wrong-desktop"),
      resolveServerLayout: resolveSourceDataRoots,
      resolveCoreServerId: async () => undefined,
      installParentDisconnectHandler: () => () => {},
      materializeZCodeBuiltinProviderConfig: async () => {
        materializations++;
        assert.fail("must reject before config IO");
      },
    },
  );
  await assert.rejects(execute(1), /Source installation identity is unavailable/);
  assert.equal(materializations, 0);
  assert.deepEqual(await readdir(temp), []);
});

test("Core launcher applies selected Source persistence after hostile release wiring", async (t) => {
  const temp = await fixture(t);
  const layout = {
    ...resolveSourceDataRoots(join(temp, "source")),
    runDir: join(temp, "source", "run"),
  };
  const launch = await productionPropertyCallback(
    "packages/zcode-server-cli/src/cli.ts",
    "launch",
    {
      layout,
      process: {
        env: { zcode_storage_dir: "bad", KEEP: "inherited" },
        platform: "win32",
        execPath: process.execPath,
      },
      runtimeOptions: {
        bundledAgentWiring: { KEEP: "release", ZCODE_SERVER_ROOT: "bad", ZCODE_STORAGE_DIR: "bad" },
      },
      createSourcePersistenceEnv,
      join,
      URL,
      fixtureModuleUrl: "file:///fixture/cli.js",
      fileURLToPath: () => "fixture-core",
      createReleaseAgentWiring: () => assert.fail("no release in fixture"),
      fork: (path, args, options) => ({ path, args, options }),
    },
  );
  const result = launch(1, undefined);
  assert.equal(result.options.env.ZCODE_SERVER_ROOT, layout.serverRoot);
  assert.equal(result.options.env.ZCODE_STORAGE_DIR, layout.storageDir);
  assert.equal(result.options.env.ZCODE_SESSION_DB_PATH, layout.sessionDatabasePath);
  assert.equal(result.options.env.zcode_storage_dir, undefined);
  assert.equal(result.options.env.KEEP, "release");
});
