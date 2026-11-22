import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { transform } from "esbuild";
import { tsImport } from "tsx/esm/api";
import { createProjectTestFixture, projectRoot } from "../project-test-sandbox.mjs";

async function sourceFunction(path, name, bindings) {
  const source = await readFile(join(projectRoot, path), "utf8");
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const node = sf.statements.find(
    (item) => ts.isFunctionDeclaration(item) && item.name?.text === name,
  );
  assert.ok(node, `Production function missing: ${name}`);
  const code = (
    await transform(node.getText(sf).replace(/^export\s+/, ""), { loader: "ts", target: "node24" })
  ).code;
  return new Function(...Object.keys(bindings), code + `; return ${name};`)(
    ...Object.values(bindings),
  );
}

test("scheduler dispatch preserves the stored additional directories", async () => {
  const root = await createProjectTestFixture("cron-dispatch");
  const messages = [];
  const post = await sourceFunction(
    "packages/desktop/src/scheduler/index.ts",
    "postDispatchRequest",
    { parentPort: { postMessage: (message) => messages.push(message) } },
  );
  const directories = [join(root, "extra")];
  post(
    {
      automationId: "automation",
      prompt: "synthetic",
      workspacePath: root,
      workspaceIdentity: "identity",
      additionalDirectories: directories,
    },
    "run",
  );
  assert.deepEqual(messages[0].additionalDirectories, directories);
  assert.equal(messages[0].runId, "run");
});

test("Main forwards additional directories through the existing CronRun schema", async () => {
  const root = await createProjectTestFixture("cron-main-forward");
  const callbacks = new Map(),
    messages = [];
  const child = {
    pid: 1,
    on: (event, callback) => callbacks.set(event, callback),
    postMessage() {},
  };
  const spawn = await sourceFunction(
    "packages/desktop/src/main/desktopCronScheduler.ts",
    "spawnCronScheduler",
    {
      electronUtilityProcess: { fork: () => child },
      schedulerModulePath: join(root, "scheduler.js"),
      buildHostProcessEnv: (env) => env,
      registerSchedulerProcess() {},
      unregisterSchedulerProcess() {},
      ingestSchedulerSelfResourceSample() {},
      HostMessageTypes: { CronRun: "cron-run" },
      DISPOSE_FORCE_KILL_MS: 1500,
    },
  );
  spawn({
    hostProcessLocalEnv: {},
    logger: { info() {}, warn() {}, error() {} },
    resolveDispatchHost: () => ({ postMessage: (message) => messages.push(message) }),
  });
  const directories = [join(root, "extra")];
  callbacks.get("message")({
    type: "cron-dispatch-request",
    automationId: "automation",
    runId: "run",
    prompt: "synthetic",
    workspacePath: root,
    additionalDirectories: directories,
  });
  assert.deepEqual(messages[0].additionalDirectories, directories);
  const { hostCronRunMessageSchema } = await tsImport(
    new URL("../../../packages/shared/src/validation.ts", import.meta.url).href,
    import.meta.url,
  );
  assert.deepEqual(hostCronRunMessageSchema.parse(messages[0]).additionalDirectories, directories);
});

test("Host creates and resumes with frozen directories and registers the exact Bot run", async () => {
  const root = await createProjectTestFixture("cron-host");
  const { watchCronRunBotDelivery } = await tsImport(
    new URL("../../../packages/desktop/src/host/cronBotDelivery.ts", import.meta.url).href,
    import.meta.url,
  );
  const calls = [];
  const selection = { providerId: "synthetic", modelId: "synthetic" };
  const taskService = {
    createTask: async (options) => {
      calls.push({ kind: "create", options });
      return { taskId: "task" };
    },
    resumeTask: async (options) => calls.push({ kind: "resume", options }),
    sendPrompt: async (options) => calls.push({ kind: "send", options }),
  };
  const botsService = {
    watchAutomationRun: async (options) => calls.push({ kind: "watch", options }),
  };
  const dispatch = await sourceFunction("packages/desktop/src/host/index.ts", "dispatchCronRun", {
    resolveAutomationTargetServices: () => ({
      getOptional: (key) => (key === "task" ? taskService : key === "model" ? {} : botsService),
    }),
    IZCodeTaskService: "task",
    IModelSelectionService: "model",
    IBotsService: "bots",
    cronAutomationRepo: {
      getRun: async () => ({ modelSelection: selection }),
      fixRunModelSelection: async () => selection,
      getBotDeliveryTarget: async () => ({ botId: "bot", chatId: "chat", platform: "synthetic" }),
    },
    resolveAutomationSubmissionModelSelection: async () => selection,
    resolveWorkspaceKey: (request) => request.workspaceIdentity ?? request.workspacePath,
    parseCronRunScheduledAt: () => 1,
    formatModelPickerValue: () => "synthetic/model",
    applyCronRunConfigToExistingTask: async () => {},
    watchCronRunBotDelivery,
    cronRunSubscriptionKey: () => "subscription",
    trackCronRunOutcome: () => {},
    disposeCronRunSubscription: () => {},
    markCronRunOutcome: () => {},
    logger: { warn: () => {} },
  });
  const directories = [join(root, "extra")];
  for (const targetTaskId of [undefined, "existing"]) {
    await dispatch({
      automationId: "automation",
      runId: "automation:manual:1",
      prompt: "synthetic",
      workspacePath: root,
      workspaceIdentity: "identity",
      additionalDirectories: directories,
      targetTaskId,
    });
  }
  for (const call of calls.filter((call) => call.kind === "create" || call.kind === "resume"))
    assert.deepEqual(call.options.additionalDirectories, directories);
  for (const call of calls.filter((call) => call.kind === "watch"))
    assert.equal(call.options.runId, "automation:manual:1");
  assert.ok(
    calls.findIndex((call) => call.kind === "watch") <
      calls.findIndex((call) => call.kind === "send"),
  );
});

test("direct manual automation dispatch preserves the same frozen directories", async () => {
  const root = await createProjectTestFixture("cron-direct-manual"),
    calls = [];
  const dispatch = await sourceFunction(
    "packages/desktop/src/host/index.ts",
    "dispatchManualAutomationRun",
    {
      logger: { info() {}, warn() {} },
      dispatchCronRun: async (request) => {
        calls.push(request);
        return { taskId: "task", sessionId: "task" };
      },
      cronAutomationRepo: { markManualRunDispatched: async () => {} },
      settleManualDispatchFailureBestEffort: async () => {},
    },
  );
  const directories = [join(root, "extra")];
  await dispatch({
    automation: {
      automationId: "automation",
      prompt: "synthetic",
      workspacePath: root,
      additionalDirectories: directories,
    },
    run: { runId: "run" },
  });
  assert.deepEqual(calls[0].additionalDirectories, directories);
});

test("custom command parsing hands shell text off without calling the execution port", async () => {
  const root = await createProjectTestFixture("custom-command-handoff");
  await mkdir(join(root, ".zcodium", "commands"), { recursive: true });
  await writeFile(
    join(root, ".zcodium", "commands", "demo.md"),
    "Run !`echo command-body`.\nFocus: $ARGUMENTS",
  );
  const { resolveZCodeCustomCommandPrompt } = await tsImport(
    new URL(
      "../../../apps/zcode-cli/packages/bootstrap/src/custom-command-prompt.ts",
      import.meta.url,
    ).href,
    import.meta.url,
  );
  let executions = 0;
  const prompt = await resolveZCodeCustomCommandPrompt("/demo !`echo argument-text`", {
    workingDirectory: root,
    skipUserConfig: true,
    env: process.env,
    executionPort: {
      run: async () => {
        executions++;
        return {
          status: "completed",
          exitCode: 0,
          stdout: { text: "executed" },
          stderr: { text: "" },
        };
      },
    },
  });
  assert.equal(executions, 0);
  assert.ok(prompt.includes("```bash\necho command-body\n```"));
  assert.ok(prompt.includes("Focus: !`echo argument-text`"));
});

test("old Supervisor candidate Core injects only the Source-root legacy cipher", async () => {
  const root = await createProjectTestFixture("core-credential-owner");
  const sourceRoot = join(root, "source");
  const calls = [];
  const source = await readFile(
    join(projectRoot, "packages/zcode-server-cli/src/server-core/core.ts"),
    "utf8",
  );
  const sf = ts.createSourceFile("core.ts", source, ts.ScriptTarget.Latest, true);
  const node = sf.statements.find(
    (item) => ts.isFunctionDeclaration(item) && item.name?.text === "runServerCore",
  );
  const code = (
    await transform(node.getText(sf).replace(/^export\s+/, ""), { loader: "ts", target: "node24" })
  ).code;
  const services = { getOptional: () => undefined, register: () => {} };
  const tracker = {
    readRunningTaskCount: () => 0,
    onDidChangeRunningTaskCount: () => ({ dispose() {} }),
    readRunningTasks: () => [],
    dispose() {},
  };
  for (const format of [undefined, "2"]) {
    const env = {
      ZCODE_SERVER_ROOT: sourceRoot,
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "synthetic",
      ...(format ? { ZCODE_SERVER_CREDENTIAL_FORMAT: format } : {}),
    };
    const bindings = {
      process: { env, send: undefined, on() {}, once() {} },
      join,
      ZCODE_APP_VERSION_ENV: "ZCODE_APP_VERSION",
      ZCODE_VERSION: "3.18.2",
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV: "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
      SERVER_CREDENTIAL_FORMAT_ENV: "ZCODE_SERVER_CREDENTIAL_FORMAT",
      SERVER_CREDENTIAL_FORMAT: 2,
      CORE_HEARTBEAT_INTERVAL_MS: 1000,
      resolveServerLayout: () => ({
        serverRoot: sourceRoot,
        configRoot: join(sourceRoot, ".zcodium", "v2"),
        runDir: join(sourceRoot, "run"),
      }),
      resolveCoreServerId: async () => "synthetic-source",
      installParentDisconnectHandler: () => () => {},
      createTopicResourcePeers: () => ({ getChannel() {} }),
      createLegacyServerCredentialCipher: async (options) => {
        calls.push({ kind: "legacy", options });
        return { syntheticLegacy: true };
      },
      createLocalServices: (options) => {
        calls.push({ kind: "services", options, format });
        return services;
      },
      ISourceWorkspaceInspectionService: "inspection",
      createNodeSourceWorkspaceInspectionService: () => ({}),
      createTaskActivityTracker: () => tracker,
      IZCodeAgentService: "agent",
      createCoreHttpServer: async () => ({ host: "synthetic", port: 1, close: async () => {} }),
      ensureIngressToken: async () => "synthetic",
      setInterval: () => 0,
      clearInterval() {},
      disposeServiceResourcesAndWait: async () => {},
    };
    const run = new Function(...Object.keys(bindings), code + ";return runServerCore;")(
      ...Object.values(bindings),
    );
    await run(1);
  }
  const legacy = calls.filter((call) => call.kind === "legacy");
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].options.filePath, join(sourceRoot, ".zcodium", "v2", "credentials.json"));
  const initialized = calls.filter((call) => call.kind === "services");
  assert.equal(initialized[0].options.credentialCipherProvider.syntheticLegacy, true);
  assert.equal(initialized[1].options.credentialCipherProvider, undefined);
});
