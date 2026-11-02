import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { loadComponentCallback } from "./fixtures/component-callback.mjs";

const hookPath = "packages/ui/src/project-sidebar/useProjectTree.ts";
// 等价比较器已搬到同目录纯模块；readOnce/commitCreatedTask 仍按 hook 源码执行。
const equalityPath = "packages/ui/src/project-sidebar/projectTreeEquality.ts";
// 固定私有样本：日志出口只要带上它就说明真实目录、身份或原始错误文本漏了出去。
const workspacePath = "C:\\Users\\fixture\\private-workspace";
const workspaceIdentity = "endpoint://fixture/private-identity";
const rawFailure = "fixture transport failure";
const logs = [];

const recorder = ({ logged = false } = {}) => {
  const calls = [];
  return {
    calls,
    push: (...args) => {
      calls.push(args);
      if (logged) logs.push(args);
    },
  };
};
// React 状态 setter 收到的是 updater；用种子执行后才拿到本次真正提交的值。
const applied = (calls, index, seed) => calls[index][0](seed);
// 日志出口按用例切片，避免上一个用例的固定事件算进本次断言。
const logMark = () => logs.length;
const logsSince = (mark) => logs.slice(mark);
const archiveCleanups = (entries) =>
  entries.filter(([message]) => message === "[project-sidebar] 归档后清理任务展示");

async function hookDeclarations() {
  const text = await readFile(new URL(`../../${hookPath}`, import.meta.url), "utf8");
  const file = ts.createSourceFile(hookPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let hook;
  const find = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "useProjectTree") hook = node;
    ts.forEachChild(node, find);
  };
  find(file);
  assert.ok(hook, "useProjectTree must stay a production hook");
  const declarations = new Map();
  const collect = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      declarations.set(node.name.text, node.initializer.getText(file));
    ts.forEachChild(node, collect);
  };
  collect(hook);
  return { text, declarations };
}

// 直接执行 hook 里的 owner 解析表达式，不把结论抄进测试。
async function resolveOwner(services) {
  const { declarations } = await hookDeclarations();
  const directoryServices = new Function(
    "services",
    `return (${declarations.get("directoryServices")});`,
  )(services);
  const service = new Function("directoryServices", `return (${declarations.get("service")});`)(
    directoryServices,
  );
  const remoteService = new Function(
    "directoryServices",
    `return (${declarations.get("remoteService")});`,
  )(directoryServices);
  return { service, remoteService };
}

async function loadReadOnce({ service, remoteService, reader, accepted, serial = { current: 0 } }) {
  // 等价比较器按生产源码执行（现位于同目录纯模块），不把等价判断抄进测试。
  const stabilize = (left, right) => left === right;
  const sameReadErrors = await loadComponentCallback(equalityPath, "sameReadErrors", {});
  const sameAvailability = await loadComponentCallback(equalityPath, "sameAvailability", {
    areStabilizedValuesEquivalent: stabilize,
  });
  const logger = {
    debug: recorder({ logged: true }).push,
    info: recorder({ logged: true }).push,
    warn: recorder({ logged: true }).push,
    error: recorder({ logged: true }).push,
  };
  const trees = recorder();
  const availability = recorder();
  const directories = recorder();
  const readErrors = recorder();
  const errors = recorder();
  const loading = recorder();
  const reads = [];
  const readOnce = await loadComponentCallback(hookPath, "readOnce", {
    serial,
    service,
    remoteService,
    readProjectSidebarTree: async (input) => {
      reads.push(input);
      return reader(input);
    },
    accepted,
    logger,
    removeTaskState: recorder().push,
    pendingCommits: { current: new Set() },
    setTree: trees.push,
    setAvailability: availability.push,
    setDirectory: directories.push,
    setHostReadErrors: readErrors.push,
    setError: errors.push,
    setLoading: loading.push,
    stabilizeProjectTree: (_previous, next) => next,
    sameAvailability,
    sameReadErrors,
    areStabilizedValuesEquivalent: stabilize,
    flushSync: (commit) => commit(),
  });
  return { readOnce, reads, trees, availability, directories, readErrors, errors, loading };
}

const task = (taskId, archived) => ({
  taskId,
  archived,
  hostId: "local",
  projectId: "project-a",
  workspacePath,
  workspaceIdentity,
});

const snapshot = (tasks, errors = new Map()) => ({
  tree: { projects: [], tasks },
  availability: new Map(),
  directory: { hosts: [], entries: [] },
  errors,
});

test("the window project directory is the only owner and there is no base service fallback", async () => {
  const { text, declarations } = await hookDeclarations();
  assert.equal(declarations.get("directoryServices"), "services.windowProjectDirectory");
  assert.equal(declarations.get("service"), "directoryServices?.projectService");
  assert.equal(declarations.get("remoteService"), "directoryServices?.remoteProjectService");
  assert.ok(
    !text.includes("windowProjectDirectory ?? services"),
    "base services must not backfill the owner",
  );
  // previous 为空时 optional chain 会与 undefined 相等，必须显式判空后才能窄化。
  assert.ok(text.includes("if (previous && previous.service === service) {"));
  assert.ok(
    text.includes(
      "if (previous && previous.service === service && previous.remote === remoteService) {",
    ),
  );
  assert.ok(
    !text.includes("previous?.service === service"),
    "optional chain cannot narrow a null snapshot",
  );
});

test("a window without a directory owner fails closed instead of borrowing base services", async () => {
  const base = {
    projectService: { readTree: async () => ({}) },
    remoteProjectService: { readDirectory: async () => ({}) },
  };
  const owner = await resolveOwner({ ...base });
  assert.equal(
    owner.service,
    undefined,
    "a missing window directory must not borrow the base project service",
  );
  assert.equal(
    owner.remoteService,
    undefined,
    "a missing window directory must not borrow the base remote service",
  );
  const { readOnce, reads, errors } = await loadReadOnce({
    service: owner.service,
    remoteService: owner.remoteService,
    accepted: { current: null },
    reader: async () => snapshot([task("task-a", false)]),
  });
  const mark = logMark();
  await readOnce();
  assert.equal(reads.length, 0, "a missing owner must not fabricate a directory service");
  assert.deepEqual(
    errors.calls.map(([value]) => value),
    ["Error: project.service-unavailable"],
  );
  assert.equal(logsSince(mark).at(-1)?.[0], "[project-sidebar] 读取项目树失败");
});

test("the real window directory services become the sidebar owner", async () => {
  const windowProject = { readTree: async () => ({}) };
  const windowRemote = { readDirectory: async () => ({ hosts: [], entries: [] }) };
  const owner = await resolveOwner({
    projectService: { readTree: async () => ({}) },
    windowProjectDirectory: { projectService: windowProject, remoteProjectService: windowRemote },
  });
  assert.equal(owner.service, windowProject);
  assert.equal(owner.remoteService, windowRemote);
  const { readOnce, reads, trees } = await loadReadOnce({
    service: owner.service,
    remoteService: owner.remoteService,
    accepted: { current: null },
    reader: async () => snapshot([task("task-a", false)]),
  });
  await readOnce();
  assert.deepEqual(reads, [{ projectService: windowProject, remoteProjectService: windowRemote }]);
  assert.deepEqual(
    applied(trees.calls, 0, { projects: [], tasks: [] }).tasks.map((row) => row.taskId),
    ["task-a"],
  );
});

test("the first snapshot is not an archive transition", async () => {
  const { readOnce } = await loadReadOnce({
    service: { readTree: async () => ({}) },
    remoteService: undefined,
    accepted: { current: null },
    reader: async () => snapshot([task("task-a", true)]),
  });
  const mark = logMark();
  await readOnce();
  await readOnce();
  assert.equal(archiveCleanups(logsSince(mark)).length, 0);
});

test("a real archived transition on the same owner cleans the row once", async () => {
  let archived = false;
  const { readOnce } = await loadReadOnce({
    service: { readTree: async () => ({}) },
    remoteService: { readDirectory: async () => ({ hosts: [], entries: [] }) },
    accepted: { current: null },
    reader: async () => snapshot([task("task-a", archived)]),
  });
  const mark = logMark();
  await readOnce();
  archived = true;
  await readOnce();
  const cleaned = archiveCleanups(logsSince(mark));
  assert.deepEqual(cleaned, [["[project-sidebar] 归档后清理任务展示", { taskId: "task-a" }]]);
  archived = true;
  await readOnce();
  assert.equal(
    archiveCleanups(logsSince(mark)).length,
    1,
    "a settled archived row must not clean again",
  );
});

test("replacing the owner or the remote service suppresses the previous snapshot's transition", async () => {
  const project = { readTree: async () => ({}) };
  const remote = { readDirectory: async () => ({ hosts: [], entries: [] }) };
  const accepted = { current: null };
  const first = await loadReadOnce({
    service: project,
    remoteService: remote,
    accepted,
    reader: async () => snapshot([task("task-a", false)]),
  });
  const mark = logMark();
  await first.readOnce();
  const replacedOwner = await loadReadOnce({
    service: { readTree: async () => ({}) },
    remoteService: remote,
    accepted,
    reader: async () => snapshot([task("task-a", true)]),
  });
  await replacedOwner.readOnce();
  const replacedRemote = await loadReadOnce({
    service: project,
    remoteService: { readDirectory: async () => ({ hosts: [], entries: [] }) },
    accepted,
    reader: async () => snapshot([task("task-a", true)]),
  });
  await replacedRemote.readOnce();
  assert.equal(
    archiveCleanups(logsSince(mark)).length,
    0,
    "a new owner or remote service has no accepted snapshot to compare against",
  );
});

test("a failed remote read keeps its raw reason out of the log exit but still reaches the view", async () => {
  const { readOnce, readErrors } = await loadReadOnce({
    service: { readTree: async () => ({}) },
    remoteService: { readDirectory: async () => ({ hosts: [], entries: [] }) },
    accepted: { current: null },
    reader: async () =>
      snapshot([task("task-a", false)], new Map([["host-a", `Error: ${rawFailure}`]])),
  });
  const mark = logMark();
  await readOnce();
  assert.deepEqual(
    [...applied(readErrors.calls, 0, new Map())],
    [["host-a", `Error: ${rawFailure}`]],
  );
  assert.deepEqual(logsSince(mark).at(-1), [
    "[project-sidebar] 读取远端项目失败",
    { hostId: "host-a" },
  ]);
});

test("a stale serial response publishes nothing", async () => {
  const accepted = { current: null };
  const serial = { current: 0 };
  const stabilize = (left, right) => left === right;
  const sameReadErrors = await loadComponentCallback(equalityPath, "sameReadErrors", {});
  const sameAvailability = await loadComponentCallback(equalityPath, "sameAvailability", {
    areStabilizedValuesEquivalent: stabilize,
  });
  const trees = recorder();
  const logged = recorder({ logged: true });
  const readOnce = await loadComponentCallback(hookPath, "readOnce", {
    serial,
    service: { readTree: async () => ({}) },
    remoteService: undefined,
    accepted,
    logger: { debug: logged.push, info: logged.push, warn: logged.push, error: logged.push },
    removeTaskState: recorder().push,
    pendingCommits: { current: new Set() },
    setTree: trees.push,
    setAvailability: recorder().push,
    setDirectory: recorder().push,
    setHostReadErrors: recorder().push,
    setError: recorder().push,
    setLoading: recorder().push,
    stabilizeProjectTree: (_previous, next) => next,
    sameAvailability,
    sameReadErrors,
    areStabilizedValuesEquivalent: stabilize,
    flushSync: (commit) => commit(),
    readProjectSidebarTree: async () => {
      serial.current++;
      return snapshot([task("task-a", true)]);
    },
  });
  await readOnce();
  assert.equal(trees.calls.length, 0);
  assert.equal(accepted.current, null);
  assert.equal(logged.calls.length, 0);
});

test("no log payload carries a real workspace path, identity or raw error", async () => {
  const walk = (value) => {
    if (typeof value === "string") return [value];
    if (!value || typeof value !== "object") return [];
    return Object.values(value).flatMap(walk);
  };
  for (const args of logs) {
    for (const value of args)
      assert.ok(!(value instanceof Error), "raw errors must not reach the log exit");
    for (const text of walk(args))
      for (const secret of [workspacePath, workspaceIdentity, rawFailure])
        assert.ok(!text.includes(secret), `logged: ${text}`);
  }
  assert.ok(logs.length > 0, "the suite must have exercised the production log exits");
});
