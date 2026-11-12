import assert from "node:assert/strict";
import test from "node:test";
import { loadComponentCallback } from "./fixtures/component-callback.mjs";

// 执行真实 Root callback，只把跨模块 IO 作为 port；不复制 controller 的导航或结算逻辑。
async function setup(open, overrides = {}) {
  const actions = [];
  const state = { activeTabId: "source-tab" };
  const ports = {
    remoteProjectOpener: { current: undefined },
    navigationSequence: { current: 0 },
    tabStoreApi: { getState: () => state },
    activeWorkspacePath: "/source-workspace",
    activeWorkspaceIdentity: null,
    useZCodeSessionStore: {
      getState: () => ({ getWorkspaceState: () => ({ activeTaskId: null, draftFocusVersion: 0 }) }),
    },
    readProjectSidebarView: () => "projects",
    services: {},
    projectService: undefined,
    resolveNewTaskTargetFromRequest: () => null,
    resolveWorkbenchNewTaskTarget: () => null,
    useWorkbenchGroupStore: { getState: () => ({ activeGroupId: null }) },
    usePaneLayoutStore: { getState: () => ({}) },
    workbenchGroupClientMode: "web-remote-replayable",
    composerClientNamespace: "source-client",
    openMobileProjectDraft: open,
    addTab: (...args) => actions.push(["tab", ...args]),
    startDraftInWorkspace: (...args) => actions.push(["draft", ...args]),
    setWorkspaceActionError: (value) => actions.push(["error", value]),
    logger: { debug() {}, info() {}, error() {} },
    toast: () => actions.push(["toast"]),
    intl: { formatMessage: ({ id }) => id },
    ...overrides,
  };
  const create = await loadComponentCallback(
    "packages/ui/src/root/useRootWorkspaceActions.ts",
    "startNewTaskFromActiveWorkspace",
    ports,
  );
  return { create, actions, state };
}

for (const unmounted of [false, true]) {
  test(`mobile Root consumes its handoff rejection without duplicate error with unmounted sender=${unmounted}`, async () => {
    let callerCurrent = true;
    let errors = 0;
    let completed = 0;
    const failure = new Error("mobile-workspace-navigation-unavailable");
    const f = await setup(async (request) => {
      if (unmounted) callerCurrent = false;
      request.onError(failure);
      throw failure;
    });
    await f.create("source", {
      projectId: "source-project",
      isCurrent: () => callerCurrent,
      onError: (error) => {
        assert.equal(error, failure);
        errors++;
      },
      onComplete: () => {
        completed++;
      },
    });
    assert.equal(errors, 1);
    assert.equal(completed, 0);
    assert.deepEqual(f.actions, []);
  });
}

test("mobile Root does not report a rejection superseded at the shared entry", async () => {
  let errors = 0;
  const f = await setup(async () => {
    throw new Error("mobile-workspace-superseded");
  });
  await f.create("source", {
    projectId: "source-project",
    isCurrent: () => true,
    onError: () => {
      errors++;
    },
  });
  assert.equal(errors, 0);
  assert.deepEqual(f.actions, []);
});

for (const change of ["tab", "draft"]) {
  test(`mobile Root passes its live ${change} lease to preparation and does not report after cancellation`, async () => {
    let handedOff;
    let reject;
    let errors = 0;
    const workspace = { activeTaskId: null, draftFocusVersion: 0 };
    const f = await setup(
      (request) => {
        handedOff = request;
        return new Promise((_resolve, fail) => {
          reject = fail;
        });
      },
      {
        useZCodeSessionStore: { getState: () => ({ getWorkspaceState: () => ({ ...workspace }) }) },
      },
    );
    const creating = f.create("source", {
      projectId: "source-project",
      isCurrent: () => true,
      onError: () => {
        errors++;
      },
    });
    assert.equal(handedOff.isCurrent(), true);
    if (change === "tab") f.state.activeTabId = "another-tab";
    else workspace.draftFocusVersion++;
    assert.equal(handedOff.isCurrent(), false);
    reject(new Error("project.navigation-cancelled"));
    await creating;
    assert.equal(errors, 0);
    assert.deepEqual(f.actions, []);
  });
}

test("ownership errors before calling the mobile entry stay at the original Root", async () => {
  let opened = 0;
  let errors = 0;
  const failure = new Error("project.workspace-scope-mismatch");
  const f = await setup(
    async () => {
      opened++;
    },
    {
      resolveNewTaskTargetFromRequest: () => {
        throw failure;
      },
    },
  );
  await f.create("source", {
    projectId: "source-project",
    onError: (error) => {
      assert.equal(error, failure);
      errors++;
    },
  });
  assert.equal(opened, 0);
  assert.equal(errors, 1);
});

test("missing mobile navigation port still reports through the original Root", async () => {
  let errors = 0;
  const f = await setup(undefined);
  await f.create("source", {
    projectId: "source-project",
    onError: () => {
      errors++;
    },
  });
  assert.equal(errors, 1);
});

test("successful mobile admission cannot write a second draft or notify completion from the old Root", async () => {
  let admitted;
  let completed = 0;
  const f = await setup(async (request) => {
    admitted = request;
  });
  await f.create("source", {
    projectId: "source-project",
    onComplete: () => {
      completed++;
    },
  });
  assert.equal(completed, 0);
  assert.deepEqual(f.actions, []);
  // 完成来自新 Root 的真实初始化；controller source 回归另证其目标租约及只通知一次。
  admitted.onComplete();
  assert.equal(completed, 1);
});
