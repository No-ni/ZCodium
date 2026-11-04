import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { loadComponentCallback } from "./fixtures/component-callback.mjs";

const historySource = await readFile("packages/ui/src/lib/taskNavigationHistory.ts", "utf8");
const historyJs = ts.transpileModule(historySource.replaceAll(/^export /gm, ""), {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
}).outputText;
const historyApi = new Function(
  historyJs +
    "\nreturn {goBack,goForward,pushNavEntry,createTaskNavigationHistory,removeTaskFromHistory,isAutomationsNavEntry,isPluginStoreNavEntry};",
)();
const guardSource = await readFile("packages/ui/src/lib/taskSwitchGuard.ts", "utf8");
const guardJs = ts
  .transpileModule(guardSource.replaceAll(/^export /gm, ""), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  })
  .outputText.replace(/^export \{\};?$/gm, "");
const restartGuard = new Function(
  guardJs + "\nreturn shouldBlockTaskSelectionDuringModelRestart;",
)();
const task = (taskId, workspaceIdentity) => ({
  kind: "task",
  taskId,
  workspacePath: "fixture-workspace",
  ...(workspaceIdentity ? { workspaceIdentity } : {}),
});

async function navigation(entries, cursor, { locked = false, workspaceIdentity, exists } = {}) {
  let history = { entries, cursor };
  const selected = [],
    scopes = [],
    toasts = [],
    logs = [];
  const step = (direction) => {
    const result = historyApi[direction](history);
    if (!result) return null;
    history = result.history;
    return result.entry;
  };
  const remove = (...args) => {
    history = historyApi.removeTaskFromHistory(history, ...args);
  };
  const dependencies = {
    workspaceAbsPath: "fixture-workspace",
    workspaceIdentity,
    useZCodeSessionStore: {
      getState: () => ({
        getWorkspaceState: (path, identity) => {
          scopes.push([path, identity]);
          return {
            modelSwitchPending: locked && identity === workspaceIdentity,
            modelSwitchStage: "restartingRuntime",
          };
        },
      }),
    },
    shouldBlockTaskSelectionDuringModelRestart: restartGuard,
    useTaskQueryCacheStore: { getState: () => ({ taskMetaByEntityKey: {} }) },
    getVisibleTaskMetas: () => [],
    taskNavigationTargetExists: ({ entry }) => exists?.(entry) ?? !entry.taskId.startsWith("gone"),
    buildTaskEntityKey: (entry) =>
      `${entry.workspaceIdentity?.trim() || entry.workspacePath}::${entry.taskId}`,
    taskNavGoBack: () => step("goBack"),
    taskNavGoForward: () => step("goForward"),
    removeTaskFromNavHistory: remove,
    isAutomationsNavEntry: historyApi.isAutomationsNavEntry,
    isPluginStoreNavEntry: historyApi.isPluginStoreNavEntry,
    activateTabByPath: () => true,
    handleSelectTask: (...args) => selected.push(args),
    onNavigateToAutomations: (entry) => selected.push(entry),
    onNavigateToPluginStore: (entry) => selected.push(entry),
    intl: { formatMessage: ({ id }) => id },
    toast: (message) => toasts.push(message),
    logger: { info: (...args) => logs.push(args) },
  };
  const back = await loadComponentCallback(
    "packages/ui/src/app-shell/useWorkspaceTaskNavigation.ts",
    "handleTaskNavBack",
    dependencies,
  );
  const forward = await loadComponentCallback(
    "packages/ui/src/app-shell/useWorkspaceTaskNavigation.ts",
    "handleTaskNavForward",
    dependencies,
  );
  return { back, forward, selected, scopes, toasts, logs, history: () => history };
}

test("WINUI20 forward skips deleted aliases sharing the same identity admitted by the history API", async () => {
  let history = historyApi.createTaskNavigationHistory();
  for (const [taskId, path] of [
    ["current", "fixture-workspace"],
    ["gone", "fixture-workspace"],
    ["gone", "fixture-workspace-alias"],
    ["next", "fixture-workspace"],
  ])
    history = historyApi.pushNavEntry(history, path, taskId, "source-a");
  assert.equal(
    history.entries.length,
    4,
    "canonical identity aliases survive raw adjacent deduplication",
  );
  const run = await navigation(history.entries, 0);
  run.forward();
  assert.equal(run.selected[0]?.[1], "next");
  assert.equal(run.history().entries[run.history().cursor].taskId, "next");
});

test("WINUI20 backward retains its predecessor when cleanup removes earlier duplicates", async () => {
  const run = await navigation(
    [task("gone"), task("previous"), task("gone"), task("current"), task("next"), task("last")],
    3,
  );
  run.back();
  assert.equal(run.selected[0]?.[1], "previous");
  assert.equal(run.history().entries[run.history().cursor].taskId, "previous");
});

for (const outcome of ["locked", "disconnected", "rejected"]) {
  test(`WINUI21 task selection ${outcome} preserves behavior without sensitive logs`, async () => {
    const logs = [],
      selected = [],
      rollbacks = [];
    const identity = outcome === "disconnected" ? "fixture-remote" : undefined;
    const callback = await loadComponentCallback(
      "packages/ui/src/app-shell/useWorkspaceTaskNavigation.ts",
      "handleSelectTask",
      {
        useZCodeSessionStore: {
          getState: () => ({
            getWorkspaceState: () => ({
              modelSwitchPending: outcome === "locked",
              modelSwitchStage: "restartingRuntime",
            }),
          }),
        },
        shouldBlockTaskSelectionDuringModelRestart: restartGuard,
        logger: { info: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
        toast() {},
        intl: { formatMessage: ({ id }) => id },
        ensureTaskNavigationWorkspace: () => ({ accepted: true }),
        tabStoreApi: { getState: () => ({ tabs: [] }) },
        buildTaskWorkspaceKey: (path, key) => key || path,
        buildTaskEntityKey: () => "fixture-entity",
        useTaskQueryCacheStore: {
          getState: () => ({
            taskMetaByEntityKey: {
              "fixture-entity": { unreadAt: 7 },
            },
          }),
        },
        setTaskQueryCacheUnreadOverlay() {},
        rollbackTaskQueryCacheUnread: (...args) => rollbacks.push(args),
        markTaskQueryCacheScopesStale() {},
        bumpTaskListMembershipVersion() {},
        baseServices: {
          zcodeTaskService: {
            setTaskUnread: async () => {
              throw new Error("E2E_RAW_ERROR_MUST_NOT_BE_LOGGED");
            },
          },
        },
        setActiveTaskId: (...args) => selected.push(args),
        onNavigateToTask() {},
      },
    );
    callback("fixture-workspace", "fixture-task", identity);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(logs.length, 1);
    const serialized = JSON.stringify(logs);
    for (const sensitive of [
      "fixture-workspace",
      "fixture-task",
      "E2E_RAW_ERROR_MUST_NOT_BE_LOGGED",
    ])
      assert.equal(serialized.includes(sensitive), false);
    assert.equal(selected.length, outcome === "locked" ? 0 : 1);
    assert.equal(rollbacks.length, outcome === "locked" ? 0 : 1);
  });
}

for (const direction of ["back", "forward"]) {
  test(`WINUI20 ${direction} preserves another workspace with the same task ID`, async () => {
    const deleted = task("gone", "source-a"),
      retained = task("gone", "source-b"),
      current = task("current");
    const entries =
      direction === "forward" ? [current, deleted, retained] : [retained, deleted, current];
    const run = await navigation(entries, direction === "forward" ? 0 : 2, {
      exists: (entry) => entry.workspaceIdentity === "source-b",
    });
    run[direction]();
    assert.equal(run.selected[0]?.[2], "source-b");
    assert.equal(run.history().entries[run.history().cursor], retained);
    assert.equal(run.history().entries.length, 2);
  });

  test(`WINUI20 ${direction} never selects the reverse target when all candidates are deleted`, async () => {
    const entries =
      direction === "forward"
        ? [
            task("current", "source-a"),
            task("gone", "source-a"),
            { ...task("gone", "source-a"), workspacePath: "fixture-workspace-alias" },
          ]
        : [
            task("gone", "source-a"),
            { ...task("gone", "source-a"), workspacePath: "fixture-workspace-alias" },
            task("current"),
            task("next"),
          ];
    const run = await navigation(entries, direction === "forward" ? 0 : 2);
    run[direction]();
    assert.deepEqual(run.selected, []);
    assert.deepEqual(run.toasts, [
      direction === "forward" ? "taskNav.noMoreForward" : "taskNav.noMoreBack",
    ]);
  });

  test(`WINUI21 ${direction} lock logs omit workspace paths`, async () => {
    const run = await navigation([task("previous"), task("current"), task("next")], 1, {
      locked: true,
      workspaceIdentity: "source-a",
    });
    run[direction]();
    assert.equal(run.logs.length, 1);
    assert.equal(JSON.stringify(run.logs).includes("fixture-workspace"), false);
  });
}

for (const deleted of [["gone"], ["gone-a", "gone-b"]]) {
  test(`WINUI07 forward keeps the successor after ${deleted.length} deleted entries`, async () => {
    const run = await navigation(
      [task("current"), ...deleted.map((id) => task(id)), task("successor")],
      0,
    );
    run.forward();
    assert.equal(run.selected[0]?.[1], "successor");
    assert.deepEqual(
      run.history().entries.map((entry) => entry.taskId),
      ["current", "successor"],
    );
    assert.equal(run.history().cursor, 1);
  });
}
test("WINUI07 a deleted final entry never navigates backward", async () => {
  const run = await navigation([task("current"), task("gone")], 0);
  run.forward();
  assert.deepEqual(run.selected, []);
  assert.deepEqual(run.toasts, ["taskNav.noMoreForward"]);
});
test("WINUI07 backward skips deleted entries without losing the predecessor", async () => {
  const run = await navigation(
    [task("previous"), task("gone-a"), task("gone-b"), task("current")],
    3,
  );
  run.back();
  assert.equal(run.selected[0]?.[1], "previous");
});
test("WINUI07 scoped history cleanup retains other workspace identities and non-task entries", () => {
  const entries = [
    task("same", " source-a "),
    task("same", "source-b"),
    task("same"),
    { kind: "plugin-store", workspacePath: "fixture-workspace" },
  ];
  const next = historyApi.removeTaskFromHistory(
    { entries, cursor: 3 },
    "same",
    "fixture-workspace",
    "source-a",
  );
  assert.deepEqual(next.entries, entries.slice(1));
  assert.equal(next.cursor, 2);
  assert.equal(
    historyApi.removeTaskFromHistory(next, "same").entries.length,
    1,
    "legacy taskId-only contract remains available",
  );
});
for (const kind of ["automations", "plugin-store"]) {
  test(`WINUI07 forward preserves a ${kind} successor after a deleted task`, async () => {
    const target = { kind, workspacePath: "fixture-workspace" };
    const run = await navigation([task("current"), task("gone"), target], 0);
    run.forward();
    assert.equal(run.selected[0]?.workspacePath, target.workspacePath);
    assert.equal(run.history().entries[run.history().cursor], target);
  });
}
for (const direction of ["back", "forward"]) {
  test(`WINUI08 ${direction} respects the active remote workspace restart lock`, async () => {
    const run = await navigation([task("previous"), task("current"), task("next")], 1, {
      locked: true,
      workspaceIdentity: "source-a",
    });
    run[direction]();
    assert.deepEqual(run.selected, []);
    assert.equal(run.history().cursor, 1);
    assert.deepEqual(run.scopes, [["fixture-workspace", "source-a"]]);
  });
}
