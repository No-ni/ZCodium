import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { InMemorySessionEventStore, type ToolSearchMode } from "@zcode/contracts";
import {
  DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
  buildServerRemoteWorkspaceIdentity,
} from "@zcode/shared";
import { createSessionRecordForV4 } from "../src/zcode-protocol/server-operations.js";
import { updateInteractionPreferences } from "../src/zcode-protocol/interaction-preferences.js";
import { buildWorkspaceRef } from "../src/zcode-protocol/workspace.js";
import {
  ProtocolRequestError,
  type ZCodeProtocolAgentServerContext,
} from "../src/zcode-protocol/server-types.js";

// 与既有 callback fixture 一样执行生产函数体，仅替换构造/IO 边界；不导出私有接口，也不启动 Agent/workflow。
async function sourceFunctions(
  file: string,
  names: string[],
  dependencies: Record<string, unknown>,
) {
  const url = new URL(`../src/${file}`, import.meta.url);
  const text = await readFile(url, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const declarations = names.map((name) => {
    const matches = source.statements.filter(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === name,
    );
    assert.equal(matches.length, 1, `exactly one production declaration: ${name}`);
    return matches[0]!.getText(source).replace(/^export\s+/u, "");
  });
  const { outputText } = ts.transpileModule(declarations.join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  });
  return new Function(
    ...Object.keys(dependencies),
    `${outputText}\nreturn { ${names.join(",")} };`,
  )(...Object.values(dependencies)) as Record<string, (...args: any[]) => any>;
}

function startupFixture(response: unknown, errorCode?: number) {
  const assembled: any[] = [];
  const requested: any[] = [];
  const initialized: boolean[] = [];
  const workspace = buildWorkspaceRef({
    workspacePath: join(tmpdir(), "tool-search-no-write-fixture"),
  });
  const context = {
    appRuntimePreferences: {
      askUserQuestionAutoResolutionEnabled: true,
      toolSearchMode: "off",
      dynamicWorkflowEnabled: false,
    },
    deps: {
      env: {},
      platform: process.platform,
      createSessionEventStore: () => new InMemorySessionEventStore(),
      createZCodeApp: async (options: any) => {
        assembled.push(options);
        return {
          sessionId: options.sessionId,
          runtime: {
            subscribeEvents: () => () => {},
            getSessionModelSelection: () => undefined,
          },
          listThoughtLevels: () => [],
        };
      },
    },
    sessions: new Map(),
    notify: () => {},
    requestClient: async (
      method: string,
      params: unknown,
      schema: { parse: (value: unknown) => unknown },
    ) => {
      requested.push({ method, params });
      if (errorCode !== undefined)
        throw new ProtocolRequestError(errorCode, "fixture host response");
      return schema.parse(response);
    },
    v4Interactions: {
      initializeAskUserQuestionAutoResolutionEnabled: async (enabled: boolean) => {
        initialized.push(enabled);
      },
    },
  } as unknown as ZCodeProtocolAgentServerContext;
  return { context, workspace, assembled, requested, initialized };
}

test("actual session materialization injects host auto/local/off and defaults old responses to Off", async () => {
  for (const mode of [undefined, "off", "auto", "local"] as const) {
    const fixture = startupFixture({
      nativeSearchEnhancementsEnabled: true,
      askUserQuestionAutoResolutionEnabled: false,
      ...(mode === undefined ? {} : { toolSearchMode: mode }),
    });
    await createSessionRecordForV4(fixture.context, {
      workspace: fixture.workspace,
      persistence: "deferred",
    });
    assert.equal(fixture.assembled.length, 1);
    assert.deepEqual(fixture.assembled[0].runtimeConfig.toolSearch, { mode: mode ?? "off" });
    assert.equal(fixture.assembled[0].runtimeConfig.workspacePath, fixture.workspace.workspacePath);
    assert.deepEqual(fixture.initialized, [false]);
    assert.equal(fixture.requested[0].params.scope, "runtime-materialization");
    assert.equal(fixture.context.sessions.size, 1);
  }
});

test("old Host method errors default Off; invalid Native and transport failures never create a runtime", async () => {
  for (const code of [-32601, -32020]) {
    const fixture = startupFixture(undefined, code);
    await createSessionRecordForV4(fixture.context, {
      workspace: fixture.workspace,
      persistence: "deferred",
    });
    assert.deepEqual(fixture.assembled[0].runtimeConfig.toolSearch, { mode: "off" });
  }
  for (const fixture of [
    startupFixture({ nativeSearchEnhancementsEnabled: true, toolSearchMode: "native" }),
    startupFixture(undefined, -32022),
  ]) {
    await assert.rejects(
      createSessionRecordForV4(fixture.context, { workspace: fixture.workspace }),
    );
    assert.equal(fixture.assembled.length, 0);
    assert.equal(fixture.context.sessions.size, 0);
  }
});

test("workspace preference command updates only matching identities through the existing runtime owner", async () => {
  const path = join(tmpdir(), "same-path-fixture");
  const workspace = buildWorkspaceRef({
    workspacePath: path,
    workspaceIdentity: buildServerRemoteWorkspaceIdentity({
      serverId: "fixture-a",
      workspacePath: path,
    }),
  });
  const otherWorkspace = buildWorkspaceRef({
    workspacePath: path,
    workspaceIdentity: buildServerRemoteWorkspaceIdentity({
      serverId: "fixture-b",
      workspacePath: path,
    }),
  });
  const updates: Record<string, unknown[]> = { main: [], background: [], child: [], other: [] };
  const fixture = startupFixture({ nativeSearchEnhancementsEnabled: true });
  fixture.context.sessions = new Map(
    Object.keys(updates).map((id) => [
      id,
      {
        workspace: id === "other" ? otherWorkspace : workspace,
        app: {
          runtime: {
            updateConfig: (config: unknown) => {
              updates[id]!.push(config);
            },
          },
        },
      } as never,
    ]),
  );
  const questionChanges: boolean[] = [];
  fixture.context.v4Interactions = {
    setAskUserQuestionAutoResolutionEnabled: async (enabled: boolean) => {
      questionChanges.push(enabled);
      return 3;
    },
  } as never;
  const result = await updateInteractionPreferences(fixture.context, {
    workspace,
    preferences: { askUserQuestionAutoResolutionEnabled: false, toolSearchMode: "local" },
  });
  assert.equal(result.toolSearchMode, "local");
  assert.equal(result.snoozedInteractionCount, 3);
  assert.equal(fixture.context.appRuntimePreferences.toolSearchMode, "local");
  for (const id of ["main", "background", "child"]) {
    assert.deepEqual(updates[id], [{ toolSearch: { mode: "local" } }]);
  }
  assert.deepEqual(updates.other, [], "same path on another remote identity is isolated");
  assert.deepEqual(questionChanges, [false]);
  await assert.rejects(
    updateInteractionPreferences(fixture.context, {
      workspace,
      preferences: { askUserQuestionAutoResolutionEnabled: true, toolSearchMode: "native" },
    }),
    (error: any) => error.code === -32602,
  );
  assert.equal(fixture.context.appRuntimePreferences.toolSearchMode, "local");
  assert.deepEqual(questionChanges, [false]);
  const old = await updateInteractionPreferences(fixture.context, {
    workspace,
    preferences: { askUserQuestionAutoResolutionEnabled: true },
  });
  assert.equal(old.toolSearchMode, "off");
});

test("inherited session startup reads the current parent runtime mode without copying record state or discovery", async () => {
  const { resolveSessionStartupPreferences } = await sourceFunctions(
    "zcode-protocol/server-operations.ts",
    ["resolveSessionStartupPreferences"],
    {
      DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
      requestSessionRuntimePreferences: () =>
        assert.fail("inherit must not request host preferences"),
    },
  );
  let mode: ToolSearchMode = "local";
  const shell = { dialect: "fixture" };
  const summary = async () => undefined;
  const parent = {
    memoryEnabled: false,
    nativeSearchEnhancementsEnabled: true,
    toolSearchMode: "off",
    resolveSummaryModelSelection: summary,
    app: { runtime: { getToolSearchMode: () => mode, getSessionShellSelection: () => shell } },
  };
  for (const current of ["local", "off", "auto", "native"] as const) {
    mode = current;
    const preferences = await resolveSessionStartupPreferences!({}, "fixture-child", {
      kind: "inherit",
      parent,
    });
    assert.equal(preferences.toolSearchMode, current);
    assert.equal(await preferences.resolveInitialBashShellSelection(), shell);
    assert.equal(preferences.resolveSummaryModelSelection, summary);
    assert.ok(!("discovered" in preferences));
  }
});

test("both child constructors inherit current ToolSearch mode at construction and keep explicit overrides", async () => {
  const captured: Array<{ config: any; deps: any }> = [];
  class CaptureRuntime {
    constructor(_sessionId: unknown, config: unknown, deps: unknown) {
      captured.push({ config, deps });
    }
  }
  const forbidden = () =>
    assert.fail("fixture must not instantiate an IO adapter or run workflow/model");
  const dependencies = {
    AgentRuntime: CaptureRuntime,
    createInMemorySessionEventStore: () => ({ fixtureEventStore: true }),
    createNodeContextSourceAdapter: forbidden,
    createNodeExecutionAdapter: forbidden,
    createNodeFileSystemAdapter: forbidden,
    createNodeWebFetchHttpClientAdapter: forbidden,
    createNodeSkillAdapter: forbidden,
    collectDisabledPaths: forbidden,
    parseProviderQualifiedModelSelection: forbidden,
    join,
    tmpdir,
  };
  const script = await sourceFunctions(
    "app/script-workflow-child-runtime.ts",
    ["createScriptWorkflowAgentRuntime", "createRuntimeDeps"],
    dependencies,
  );
  const expert = await sourceFunctions(
    "app/workflow-facade.ts",
    ["createWorkflowChildRuntime"],
    dependencies,
  );
  let currentMode: ToolSearchMode = "off";
  const ports = { fixturePort: true };
  const deps = {
    appOptions: {
      contextSourcePort: ports,
      executionPort: ports,
      fileSystemPort: ports,
      httpClientPort: ports,
    },
    configResult: { config: { features: { skill: false } } },
    runtime: {
      getToolSearchMode: () => currentMode,
      getSessionModelSelection: () => ({ providerId: "fixture", modelId: "fixture" }),
      getSessionEventStore: () => ports,
      createChildClientPorts: () => ({ permissionBroker: ports }),
    },
    runtimeConfig: { toolSearch: { mode: "local" }, systemPrompt: "fixture prompt" },
    sessionId: "fixture-parent",
    workingDirectory: join(tmpdir(), "fixture-cwd-no-write"),
    storageRoot: join(tmpdir(), "fixture-storage-no-write"),
    imageProcessorPort: ports,
    contextSourcePort: ports,
  };
  for (const mode of ["off", "auto", "native"] as const) {
    currentMode = mode;
    script.createScriptWorkflowAgentRuntime!({
      deps,
      childSessionId: "fixture-script-child",
      request: {},
      traceContext: {},
    });
    expert.createWorkflowChildRuntime!(deps, {
      childSessionId: "fixture-expert-child",
      childTraceContext: {},
      workflowKind: "expert",
    });
    for (const constructed of captured.splice(0)) {
      assert.deepEqual(constructed.config.toolSearch, { mode });
      assert.notEqual(constructed.config.toolSearch, deps.runtimeConfig.toolSearch);
      assert.equal(constructed.config.parentSessionId, "fixture-parent");
      assert.equal(constructed.deps.permissionBroker, ports);
      assert.ok(!("messageHistory" in constructed.deps));
    }
  }
  script.createScriptWorkflowAgentRuntime!({
    deps,
    childSessionId: "fixture-override-child",
    request: {},
    traceContext: {},
    configOverrides: { toolSearch: { mode: "off" } },
  });
  assert.deepEqual(captured[0]!.config.toolSearch, { mode: "off" });
  assert.deepEqual(
    deps.runtimeConfig.toolSearch,
    { mode: "local" },
    "captured assembly config is not mutated",
  );
});
