import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import ts from "typescript";
import { createProjectService } from "../../../packages/services/src/project/index.ts";
import { resolveStartupWindowBootstrap } from "../../../packages/desktop/src/main/startupWorkspace.ts";
import { createTabStore } from "../../../packages/ui/src/store/tabStore.ts";
import { restorePersistedRemoteWorkspaceSessions } from "../../../packages/ui/src/root/remoteWorkspaceSessionPersistence.ts";
import * as drafts from "../../../packages/ui/src/v4/composer/composerDraftStore.ts";
import {
  shouldBlockRootRender,
  shouldOpenFallbackWorkspaceAfterCreate,
} from "../../../packages/ui/src/lib/rootStartupGate.ts";
import { assertProjectPath } from "../project-test-sandbox.mjs";
import { loadComponentCallback } from "./component-callback.mjs";
import { createProjectlessAdmission } from "./projectless-task-admission.mjs";

const initialWindow = globalThis.window;
afterEach(() => {
  if (initialWindow === undefined) delete globalThis.window;
  else globalThis.window = initialWindow;
});
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const taskScope = drafts.resolveComposerScope(null, undefined, "desktop");
const selection = {
  providerId: "fixture-provider",
  modelId: "fixture-model",
  options: { reasoningLevel: "high" },
};

for (const hasSettings of [false, true])
  test(`PTW01: Main ${hasSettings ? "空设置" : "缺席设置"} 只准备进程后备 cwd，不指定 default 初始页签`, async () => {
    const root = await assertProjectPath(
      join(process.env.PROJECT_TEST_SANDBOX_ROOT, "main-startup", randomUUID()),
    );
    await mkdir(root, { recursive: true });
    const settingsFile = join(root, "setting.json");
    if (hasSettings)
      await writeFile(
        settingsFile,
        JSON.stringify({ lastActiveWorkspace: null, lastWorkspaceSession: [] }),
      );
    const conversationWorkspaceDir = join(root, "workspace", "default");
    const bootstrap = await resolveStartupWindowBootstrap({
      settingsFile,
      conversationWorkspaceDir,
      logger,
    });
    assert.equal(bootstrap.initialWorkspacePath, undefined);
    assert.equal(bootstrap.initialWorkspacePurpose, undefined);
    assert.deepEqual(bootstrap.agentWarmupTargets, [{ workspacePath: conversationWorkspaceDir }]);
    assert.equal((await stat(conversationWorkspaceDir)).isDirectory(), true);
  });

test("PTW03: Main 恢复已保存任务时仍预热其原路径，不重算任务目录", async () => {
  const root = await assertProjectPath(
    join(process.env.PROJECT_TEST_SANDBOX_ROOT, "main-startup", randomUUID()),
  );
  const workspacePath = join(root, "workspace", `draft-${randomUUID()}`);
  await mkdir(workspacePath, { recursive: true });
  const settingsFile = join(root, "setting.json");
  await writeFile(
    settingsFile,
    JSON.stringify({
      lastWorkspaceSession: [{ kind: "local", workspacePath, workspacePurpose: "conversation" }],
    }),
  );
  const bootstrap = await resolveStartupWindowBootstrap({
    settingsFile,
    conversationWorkspaceDir: join(root, "workspace", "default"),
    logger,
  });
  assert.equal(bootstrap.initialWorkspacePath, undefined);
  assert.deepEqual(bootstrap.agentWarmupTargets, [{ workspacePath }]);
});
function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// 驱动 Root 实际 effect；只抽取该 effect 的依赖，不复制启动分配逻辑。
async function loadStartupEffect(context) {
  const path = "packages/ui/src/Root.tsx";
  const sourceText = await readFile(new URL(`../../../${path}`, import.meta.url), "utf8");
  const source = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const effects = [];
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "useEffect" &&
      node.arguments[0]?.getText(source).includes("setHasRequestedFallbackWorkspace(true)")
    )
      effects.push(node.arguments[0].getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(effects.length, 1);
  const { outputText } = ts.transpileModule(`const callback = ${effects[0]};`, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  });
  return new Function(...Object.keys(context), `${outputText}\nreturn callback;`)(
    ...Object.values(context),
  );
}

async function startupFixture(overrides = {}) {
  const starts = [],
    legacy = [],
    loading = [],
    errors = [];
  const nav = { activeTabId: null, activeWorkspacePath: null };
  const mounted = { current: true };
  const context = {
    shouldBlockRootRender,
    shouldOpenFallbackWorkspaceAfterCreate,
    isRestoring: false,
    isBootstrappingInitialWorkspace: false,
    workspaceShellPath: null,
    isSettingsTabActive: false,
    allowOpenWorkspace: true,
    hasRequestedFallbackWorkspace: false,
    rootInnerMountedRef: mounted,
    tabStoreApi: { getState: () => nav },
    logger,
    setHasRequestedFallbackWorkspace() {},
    setIsCreatingFallbackWorkspace: (value) => loading.push(value),
    setWorkspaceActionError: (error) => errors.push(error),
    handleSelectConversationWorkspace: (path) => legacy.push(path),
    services: {
      fileService: {
        ensureConversationWorkspace: async () => {
          legacy.push("ensure-default");
          return { path: "fixture-default" };
        },
      },
    },
    startNewTaskFromActiveWorkspace: async (source, request) => {
      starts.push({ source, request });
    },
    ...overrides,
  };
  const run = async () => {
    (await loadStartupEffect(context))();
    await new Promise(setImmediate);
  };
  return { context, nav, mounted, starts, legacy, loading, errors, run };
}

test("PTW01: 空启动显式无项目并进入现有任务新建 action，不再创建 default", async () => {
  const f = await startupFixture();
  await f.run();
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].request.projectId, null);
  assert.deepEqual(f.legacy, []);
  assert.deepEqual(f.loading, [true, false]);
});

test("PTW01/03: 恢复/初始打开/项目/设置页/禁止打开时不发启动任务", async () => {
  for (const overrides of [
    { isRestoring: true },
    { isBootstrappingInitialWorkspace: true },
    { workspaceShellPath: "fixture-project" },
    { isSettingsTabActive: true },
    { allowOpenWorkspace: false },
    { hasRequestedFallbackWorkspace: true },
  ]) {
    const f = await startupFixture(overrides);
    await f.run();
    assert.deepEqual(f.starts, []);
    assert.deepEqual(f.legacy, []);
    assert.deepEqual(f.loading, []);
  }
});

test("PTW03: 启动请求携带活跃窗口守卫，目录准备迟到或卸载后不可提交", async () => {
  const f = await startupFixture();
  await f.run();
  assert.equal(f.starts[0]?.request.isCurrent(), true);
  f.nav.activeWorkspacePath = "fixture-project";
  assert.equal(f.starts[0].request.isCurrent(), false);
  f.nav.activeWorkspacePath = null;
  f.mounted.current = false;
  assert.equal(f.starts[0].request.isCurrent(), false);
});

test("PTW01: 启动新建失败保留错误出口并结束 loading", async () => {
  const f = await startupFixture({
    startNewTaskFromActiveWorkspace: async (_source, request) => {
      request.onError(new Error("fixture-directory-unavailable"));
    },
  });
  await f.run();
  assert.deepEqual(f.errors, ["fixture-directory-unavailable"]);
  assert.deepEqual(f.loading, [true, false]);
});

async function taskFixture() {
  globalThis.window = { localStorage: memoryStorage() };
  const workspaceDirectory = await assertProjectPath(
    join(process.env.PROJECT_TEST_SANDBOX_ROOT, "task-navigation", randomUUID()),
  );
  await mkdir(workspaceDirectory, { recursive: true });
  const service = createProjectService({
    workspaceDirectory,
    repository: async () => {
      throw new Error("projectless fixture must not consult repository");
    },
  });
  const navigation = { activeTabId: null, activeWorkspacePath: null };
  const states = new Map(),
    added = [],
    started = [],
    errors = [];
  const getState = (path) =>
    states.get(path) ?? { activeTaskId: null, draftFocusVersion: 0, draftProjectId: null };
  const sessionStore = {
    getState: () => ({
      getWorkspaceState: (path) => ({ ...getState(path) }),
      startDraft: (path, _provider, _identity, options) => {
        states.set(path, {
          activeTaskId: null,
          draftFocusVersion: getState(path).draftFocusVersion + 1,
          draftProjectId: options.projectId,
        });
        started.push(path);
      },
    }),
  };
  const startDraftInWorkspace = await loadComponentCallback(
    "packages/ui/src/root/useRootWorkspaceActions.ts",
    "startDraftInWorkspace",
    {
      ...drafts,
      composerClientNamespace: "desktop",
      workbenchGroupClientMode: "desktop-continuous",
      useWorkbenchGroupStore: { getState: () => ({ deactivateActiveGroup() {} }) },
      usePaneLayoutStore: { getState: () => ({ resetToPrimaryPane() {} }) },
      useZCodeSessionStore: sessionStore,
    },
  );
  const common = {
    logger,
    composerClientNamespace: "desktop",
    navigationSequence: { current: 0 },
    remoteProjectOpener: { current: undefined },
    tabStoreApi: { getState: () => navigation },
    services: {},
    useZCodeSessionStore: sessionStore,
    readProjectSidebarView: () => "projects",
    resolveNewTaskTargetFromRequest: () => null,
    resolveWorkbenchNewTaskTarget: () => null,
    workbenchGroupClientMode: "desktop-continuous",
    projectService: service,
    ensurePendingTaskDraft: drafts.ensurePendingTaskDraft,
    resolveComposerScope: drafts.resolveComposerScope,
    startDraftInWorkspace,
    setWorkspaceActionError() {},
    toast: (error) => errors.push(error),
    intl: { formatMessage: ({ id }) => id },
    addTab: (path) => {
      added.push(path);
      navigation.activeTabId = `tab:${path}`;
      navigation.activeWorkspacePath = path;
    },
  };
  const action = async (request = { projectId: null }) => {
    const callback = await loadComponentCallback(
      "packages/ui/src/root/useRootWorkspaceActions.ts",
      "startNewTaskFromActiveWorkspace",
      {
        ...common,
        activeWorkspacePath: navigation.activeWorkspacePath,
        activeWorkspaceIdentity: null,
      },
    );
    return callback("fixture task create", request);
  };
  return { workspaceDirectory, service, navigation, common, added, started, errors, action };
}

test("PTW02: 真实 Host 准备与 Root 草稿绑定复用目录、正文和完整选择，接纳后换目录", async () => {
  const f = await taskFixture();
  await f.action();
  const first = f.navigation.activeWorkspacePath;
  assert.match(first, /draft-[0-9a-f-]{36}$/i);
  drafts.persistV4ComposerDraft(
    first,
    undefined,
    drafts.V4_DRAFT_SCOPE_ROOT,
    { text: "unsent task", mode: "guarded", modelSelection: selection },
    taskScope,
  );
  await writeFile(join(first, "note.txt"), "task A");
  await f.action();
  assert.equal(f.navigation.activeWorkspacePath, first);
  const saved = drafts.readV4ComposerDraft(first, undefined, drafts.V4_DRAFT_SCOPE_ROOT, taskScope);
  assert.equal(saved.text, "unsent task");
  assert.equal(saved.mode, "guarded");
  assert.deepEqual(saved.modelSelection, selection);
  assert.equal(drafts.readPendingTaskDraft(taskScope).workspacePath, first);
  const admission = await createProjectlessAdmission({
    workspacePath: first,
    selection,
    workspaceState: () => f.common.useZCodeSessionStore.getState().getWorkspaceState(first),
  });
  await admission.send("unsent task");
  assert.equal(drafts.readPendingTaskDraft(taskScope), null, "实际首发接纳必须消费目录引用");
  await f.action();
  const second = f.navigation.activeWorkspacePath;
  assert.notEqual(second, first);
  assert.equal(await readFile(join(first, "note.txt"), "utf8"), "task A");
  await assert.rejects(stat(join(second, "note.txt")), { code: "ENOENT" });
  assert.equal((await readdir(f.workspaceDirectory)).length, 2);
});

test("PTW02: 并发新建使用同 draftId，只提交最新导航且仅有一个真实目录", async () => {
  const f = await taskFixture();
  await Promise.all([f.action(), f.action()]);
  assert.equal((await readdir(f.workspaceDirectory)).length, 1);
  assert.equal(f.added.length, 1);
  assert.equal(f.started.length, 1);
});

test("PTW03: 准备期间打开项目、设置页或卸载，实际 action 不抢导航", async () => {
  for (const kind of ["project", "settings", "unmount"]) {
    const f = await taskFixture();
    const gate = deferred(),
      entered = deferred();
    f.common.projectService = {
      prepareSession: async (input) => {
        entered.resolve();
        await gate.promise;
        return f.service.prepareSession(input);
      },
    };
    let mounted = true;
    const creating = f.action({ projectId: null, isCurrent: () => mounted });
    await entered.promise;
    if (kind === "unmount") mounted = false;
    else {
      f.navigation.activeTabId = kind;
      f.navigation.activeWorkspacePath = kind === "project" ? "fixture-project" : null;
    }
    gate.resolve();
    await creating;
    assert.deepEqual(f.added, []);
    assert.deepEqual(f.started, []);
    assert.deepEqual(f.errors, []);
  }
});

test("PTW07: 真实待发送目录移走后报错，保留目录引用、正文与现有导航", async () => {
  const f = await taskFixture();
  await f.action();
  const first = f.navigation.activeWorkspacePath;
  drafts.persistV4ComposerDraft(
    first,
    undefined,
    drafts.V4_DRAFT_SCOPE_ROOT,
    { text: "retain draft" },
    taskScope,
  );
  const moved = await assertProjectPath(`${first}.moved`);
  await assertProjectPath(first);
  await rename(first, moved);
  const failures = [];
  await f.action({ projectId: null, onError: (error) => failures.push(error) });
  assert.equal(failures[0]?.code, "ENOENT");
  assert.equal(f.navigation.activeWorkspacePath, first);
  assert.equal(drafts.readPendingTaskDraft(taskScope).workspacePath, first);
  assert.equal(
    drafts.readV4ComposerDraft(first, undefined, drafts.V4_DRAFT_SCOPE_ROOT, taskScope).text,
    "retain draft",
  );
  await assert.rejects(stat(first), { code: "ENOENT" });
  assert.equal((await stat(moved)).isDirectory(), true);
});

test("PTW02: conversation 新建回调显式无项目，不能继承当前项目", async () => {
  const requests = [];
  const create = await loadComponentCallback(
    "packages/ui/src/root/useConversationWorkspaceActions.ts",
    "handleCreateConversationTask",
    {
      createTask: async (...args) => requests.push(args),
    },
  );
  await create();
  assert.equal(requests[0][1]?.projectId, null);
});

for (const modern of [false, true])
  test(`PTW03: ${modern ? "新版活动记录" : "旧 lastWorkspaceSession"} 恢复保留原 task/default 路径且不准备 canonical 根`, async () => {
    globalThis.window = { localStorage: memoryStorage() };
    const tabs = createTabStore(null);
    const paths = ["fixture/default", "fixture/draft-a", "fixture/draft-b"];
    const entries = paths.map((workspacePath) => ({
      kind: "local",
      workspacePath,
      workspacePurpose: "conversation",
    }));
    const settings = modern
      ? { lastActiveWorkspace: entries[1] }
      : { lastWorkspaceSession: entries, lastActiveTabIndex: 1 };
    const prepared = [];
    const restore = await loadComponentCallback(
      "packages/ui/src/root/useRemoteWorkspaceHistory.ts",
      "restorePersistedSession",
      {
        getRemoteWorkspaceSessionEntries: () => [],
        setRemoteWorkspaceSessions() {},
        remoteWorkspaceSessionsRef: { current: [] },
        ensureConversationWorkspaceOnRestore: true,
        services: {
          fileService: {
            ensureConversationWorkspace: async () => {
              prepared.push(true);
              return { path: "fixture/canonical-default" };
            },
          },
        },
        restorePersistedRemoteWorkspaceSessions,
        tabStoreApi: tabs,
        allowRemoteWorkspaceRestore: true,
        unavailableWorkspacePath: undefined,
        deferInactiveWorkspaceRestore: false,
        logger,
      },
    );
    await restore(settings);
    assert.deepEqual(prepared, []);
    assert.equal(tabs.getState().activeWorkspacePath, paths[1]);
    assert.deepEqual(
      tabs.getState().tabs.map((tab) => tab.workspacePath),
      modern ? [paths[1]] : paths,
    );
    assert.ok(tabs.getState().tabs.every((tab) => tab.workspacePurpose === "conversation"));
  });

test("PTW03: active-first 补齐仍保留不同任务目录，已关闭 active tab 不复活", () => {
  const tabs = createTabStore(null);
  const entries = ["fixture/task-a", "fixture/task-b"].map((workspacePath) => ({
    kind: "local",
    workspacePath,
    workspacePurpose: "conversation",
  }));
  const result = restorePersistedRemoteWorkspaceSessions({
    settings: { lastWorkspaceSession: entries, lastActiveTabIndex: 1 },
    tabStoreApi: tabs,
    restoreMode: "active-first",
  });
  assert.equal(tabs.getState().activeWorkspacePath, entries[1].workspacePath);
  tabs.getState().closeTab(tabs.getState().activeTabId);
  result.deferredRestore();
  assert.deepEqual(
    tabs.getState().tabs.map((tab) => tab.workspacePath),
    [entries[0].workspacePath],
  );
});

test("PTW03: 失效项目保留原活动入口与不可用标记，其他任务路径照常补齐", () => {
  const tabs = createTabStore(null);
  const entries = [
    { kind: "local", workspacePath: "fixture/missing-project" },
    { kind: "local", workspacePath: "fixture/draft-task", workspacePurpose: "conversation" },
  ];
  const result = restorePersistedRemoteWorkspaceSessions({
    settings: { lastWorkspaceSession: entries, lastActiveTabIndex: 0 },
    tabStoreApi: tabs,
    unavailableWorkspacePath: entries[0].workspacePath,
    restoreMode: "active-first",
  });
  assert.equal(tabs.getState().activeWorkspacePath, entries[0].workspacePath);
  assert.equal(tabs.getState().tabs[0].availability, "unavailable-local-directory");
  result.deferredRestore();
  assert.equal(tabs.getState().activeWorkspacePath, entries[0].workspacePath);
  assert.deepEqual(
    tabs.getState().tabs.map((tab) => tab.workspacePath),
    entries.map((entry) => entry.workspacePath),
  );
});
