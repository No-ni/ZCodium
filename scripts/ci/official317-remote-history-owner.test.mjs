import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { loadComponentCallback } from "./fixtures/component-callback.mjs";
import { buildRemoteWorkspaceIdentity } from "@zcode/shared";

async function actual(selector, dependencies) {
  const text = await readFile(
    new URL("../../packages/ui/src/root/useRemoteWorkspaceHistory.ts", import.meta.url),
    "utf8",
  );
  const file = ts.createSourceFile("history.ts", text, ts.ScriptTarget.Latest, true);
  const matches = [];
  function visit(node) {
    if (selector(node, file)) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.equal(matches.length, 1);
  const node = matches[0];
  const expression = ts.isFunctionDeclaration(node)
    ? node.getText(file).replace(/^export\s+/, "")
    : node.getText(file);
  const { outputText } = ts.transpileModule(`const actual = ${expression};`, {
    compilerOptions: { target: ts.ScriptTarget.ESNext },
  });
  return new Function(...Object.keys(dependencies), `${outputText}\nreturn actual;`)(
    ...Object.values(dependencies),
  );
}

test("void bind ACK rereads the authoritative attachment after replacement", async () => {
  let session = {
    sessionId: "fixture-session",
    services: { generation: 1 },
    workspaceIdentity: "old",
  };
  const bind = await actual(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "bindRemoteWorkspaceContextAndGetSession",
    { getRemoteWorkspaceSession: () => session },
  );
  const next = {
    sessionId: "fixture-session",
    services: { generation: 2 },
    sourceServerId: "fixture-source",
    workspacePath: "/canonical",
    workspaceIdentity: "canonical",
    previousWorkspaceIdentity: "old",
    workspacePurpose: "project",
  };
  const bound = await bind({
    sessionId: "fixture-session",
    workspacePath: "/alias",
    platform: {
      async bindRemoteWorkspaceSessionContext() {
        session = next;
      },
    },
  });
  assert.deepEqual(bound, next);
});

const state = (status, generation = 1) => ({
  profileId: "fixture-profile",
  sourceServerId: "fixture-source",
  state: status,
  generation,
});
const snapshot = (status, generation = 1) => ({
  directory: { generation, profiles: [{ profileId: "fixture-profile" }], servers: [] },
  states: [state(status, generation)],
});
const drain = async () => {
  for (let n = 0; n < 8; n++) await new Promise((resolve) => setImmediate(resolve));
};

async function mount(read) {
  let notify,
    unsubscribed = false;
  const projections = [],
    attempts = [],
    events = [];
  const lifecycle = {
    attemptedWorkspaceKeys: new Set(),
    currentRendererDisconnectedSourceServerIds: new Set(),
    pendingTerminallyDisconnectedSourceServerIds: new Set(),
    observedOnlineSourceServerIds: new Set(),
  };
  const settings = {
    sourceServerWorkspaceHistory: [{ workspacePath: "/fixture" }],
    remoteConversationWorkspaceBySourceServerId: {},
  };
  const dependencies = {
    services: {
      sourceServerManagementService: {
        getSnapshot: read,
        onDidChange(fn) {
          notify = fn;
          return {
            dispose() {
              unsubscribed = true;
            },
          };
        },
      },
      settingService: { get: async () => settings },
    },
    canUseRemoteWorkspace: true,
    remoteWorkspaceSessions: [{}],
    remoteWorkspaceSessionsRef: { current: [{}] },
    manuallyOpeningWorkspaceTabIdRef: { current: undefined },
    remoteWorkspaceReconnectRendererState: lifecycle,
    projectRemoteWorkspaceSessionIdentityAliases(_sessions, input) {
      projections.push(input);
      return { identityRekeys: [] };
    },
    collectStartupRemoteWorkspaceReconnectGroups(input) {
      attempts.push([...input.onlineSourceServerIds]);
      return [];
    },
    updateStartupRemoteWorkspaceReconnectAttemptsForSourceState(input) {
      events.push(input.state.state);
    },
    tabStoreApi: { getState: () => ({ tabs: [] }), subscribe: () => () => {} },
    setRemoteWorkspaceSessions() {},
    isWorkspaceTab: () => false,
    buildWorkspaceSessionKey() {},
    restoreSourceRemoteWorkspaceGroup() {},
    runReconnectRemoteWorkspaceEntry() {},
    logger: { warn() {} },
  };
  const effect = await actual(
    (node, file) =>
      ts.isArrowFunction(node) &&
      ts.isCallExpression(node.parent) &&
      node.parent.expression.getText(file) === "useEffect" &&
      node.getText(file).includes("observedManagementGeneration"),
    dependencies,
  );
  const cleanup = effect();
  await drain();
  return {
    notify: () => notify(),
    cleanup,
    projections,
    attempts,
    events,
    lifecycle,
    settings,
    unsubscribed: () => unsubscribed,
  };
}

test("the single management event refreshes states and reads aliases from settings", async () => {
  let current = snapshot("offline");
  const run = await mount(async () => current);
  assert.deepEqual(run.projections[0], {
    ...run.settings,
    connectionProfiles: current.directory.profiles,
  });
  current = snapshot("online", 2);
  run.notify();
  await drain();
  assert.deepEqual(run.attempts.at(-1), ["fixture-source"]);
  const count = run.attempts.length;
  current = snapshot("online", 3);
  run.notify();
  await drain();
  assert.equal(
    run.attempts.length,
    count,
    "directory-only change must not manufacture a reconnect signal",
  );
  current = snapshot("offline", 4);
  run.notify();
  await drain();
  assert.equal(run.attempts.length, count);
  assert.deepEqual([...run.lifecycle.observedOnlineSourceServerIds], []);
  run.cleanup();
  assert.equal(run.unsubscribed(), true);
});

test("queued refresh is serialized and retired effects cannot publish late settings", async () => {
  let release;
  const first = new Promise((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const run = await mount(() => {
    reads++;
    return reads === 1 ? first : Promise.resolve(snapshot("online", 2));
  });
  run.notify();
  run.notify();
  assert.equal(reads, 1);
  run.cleanup();
  release(snapshot("online"));
  await drain();
  assert.equal(reads, 1);
  assert.deepEqual(run.projections, []);
  assert.deepEqual(run.attempts, []);
});

test("Bot reconnect keeps its captured identity and publishes through the current directory", async () => {
  const calls = [];
  const target = { kind: "wsl", distro: "fixture" };
  const resolveIdentity = await actual(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "resolveBotRemoteWorkspaceReconnectedIdentity",
    { buildRemoteWorkspaceIdentity },
  );
  const reconnect = await loadComponentCallback(
    "packages/ui/src/root/useRemoteWorkspaceHistory.ts",
    "handleBotRemoteWorkspaceReconnected",
    {
      canUseRemoteWorkspace: true,
      waitForRemoteWorkspaceSessionReady: async () => {},
      getRemoteWorkspaceSession: () => ({ sessionId: "fixture-session", target }),
      resolveRemoteWorkspaceCanonicalPath: async () => "/canonical",
      resolveBotRemoteWorkspaceReconnectedIdentity: resolveIdentity,
      bindRemoteWorkspacePath: (...args) => calls.push(["path", ...args]),
      bindRemoteWorkspaceIdentity: (...args) => calls.push(["identity", ...args]),
      tabStoreApi: {
        getState: () => ({ ensureWorkspaceTab: (...args) => calls.push(["tab", ...args]) }),
      },
      remoteWorkspaceSessionsRef: { current: [] },
      buildRemoteWorkspaceSessionMutation: (input) => input,
      commitRemoteWorkspaceSessionMutation: async (input) => calls.push(["directory", input]),
      logger: { warn: (...args) => calls.push(["warn", ...args]) },
    },
  );
  await reconnect({
    sessionId: "fixture-session",
    workspacePath: "/alias",
    workspaceIdentity: "captured-identity",
    target,
  });
  assert.deepEqual(
    calls.map((call) => call[0]),
    ["path", "identity", "tab", "directory"],
  );
  assert.deepEqual(calls[1], ["identity", "captured-identity", "fixture-session"]);
  assert.equal(calls[2][2].workspaceIdentity, "captured-identity");
  assert.equal(calls[3][1].workspaceIdentity, "captured-identity");
});
