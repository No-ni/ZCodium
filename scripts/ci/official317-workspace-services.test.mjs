import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function load(path, modules) {
  const source = await readFile(new URL(`../../${path}`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const module = { exports: {} };
  new Function("require", "module", "exports", outputText)(
    (name) => {
      assert.ok(name in modules, `Unexpected production dependency: ${name}`);
      return modules[name];
    },
    module,
    module.exports,
  );
  return module.exports;
}

async function fixture() {
  const base = { owner: "local" },
    remote = { owner: "remote-a" },
    settings = { owner: "settings-b" };
  const tab = {
    id: "tab",
    type: "workspace",
    workspacePath: "same-path",
    workspaceIdentity: "endpoint-a",
    remoteSessionId: "a",
    remoteTarget: { kind: "ssh" },
  };
  const state = {
    baseServices: base,
    sessionsById: { a: { services: remote } },
    sessionIdByWorkspaceIdentity: { "endpoint-a": "a" },
    sessionIdByWorkspacePath: { "same-path": "a" },
  };
  const tabState = {
    activeTabId: "tab",
    activeWorkspacePath: tab.workspacePath,
    activeWorkspaceIdentity: tab.workspaceIdentity,
    tabs: [tab],
  };
  const stores = {
    "@/store/TabStoreProvider.js": { useTabStore: (select) => select(tabState) },
    "@/store/tabStore.js": { isWorkspaceTab: (value) => value?.type === "workspace" },
    "@/store/remoteWorkspaceSessionStore.js": {
      useRemoteWorkspaceSessionStore: (select) => select(state),
    },
  };
  const resolver = await load("packages/ui/src/lib/workspaceServiceResolver.ts", {
    "@/lib/taskQueryCache.js": {
      buildTaskWorkspaceKey: () => {
        throw Error("Unexpected lookup cache access");
      },
    },
  });
  const resolvedHook = await load("packages/ui/src/hooks/useResolvedRemoteWorkspaceSessionId.ts", {
    ...stores,
    "@/lib/workspaceServiceResolver.js": resolver,
  });
  const disconnected = { owner: "disconnected" };
  const hooks = await load("packages/ui/src/hooks/useWorkspaceServices.tsx", {
    ...stores,
    "@zcode/rpc": { Event: { None: () => {} }, ProxyChannel: { toService: () => disconnected } },
    react: { useMemo: (fn) => fn() },
    "@/hooks/useServices.js": { useServices: () => remote, useOptionalServices: () => remote },
    "@/hooks/useResolvedRemoteWorkspaceSessionId.js": resolvedHook,
    "@/lib/remoteWorkspaceServiceError.js": {
      REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE: "disconnected",
    },
  });
  return { ...hooks, base, remote, settings, state, disconnected };
}

test("Exact local routing cannot borrow an active remote tab at the same path", async () => {
  const f = await fixture();
  const local = f.useWorkspaceServicesResolution("same-path", null, null, null, "exact");
  assert.equal(local.services, f.base);
  assert.equal(local.connectionKind, "local-ready");
  assert.equal(local.remoteSessionId, null);
  assert.equal(f.useWorkspaceServices("same-path", null, null, null, "exact"), f.base);
  const ambient = f.useWorkspaceServicesResolution("same-path", null, null, null, "ambient");
  assert.equal(ambient.services, f.remote);
  assert.equal(ambient.remoteSessionId, "a");
  assert.equal(ambient.connectionKind, "remote-ready");
});

test("An unmatched exact remote identity stays waiting until its own attachment is registered", async () => {
  const f = await fixture();
  const waiting = f.useWorkspaceServicesResolution("same-path", null, "endpoint-b", null, "exact");
  assert.equal(waiting.connectionKind, "remote-waiting");
  assert.equal(waiting.rpcReady, false);
  assert.equal(waiting.services.anyService, f.disconnected);
  f.state.sessionsById.b = { services: f.settings };
  f.state.sessionIdByWorkspaceIdentity["endpoint-b"] = "b";
  const ready = f.useWorkspaceServicesResolution("same-path", null, "endpoint-b", null, "exact");
  assert.equal(ready.services, f.settings);
  assert.equal(ready.remoteSessionId, "b");
  assert.equal(ready.rpcReady, true);
});

test("Settings options preserve explicit unscoped routing and allow exact workspace routing", async () => {
  const f = await fixture();
  const scoped = f.useWorkspaceServicesResolution("same-path", "a", "endpoint-a", null, {
    unscopedServices: f.settings,
    forceUnscoped: true,
  });
  assert.equal(scoped.services, f.settings);
  assert.equal(scoped.remoteSessionId, null);
  assert.equal(scoped.connectionKind, "local-ready");
  assert.equal(
    f.useWorkspaceServicesResolution("same-path", null, null, null, { scopeResolution: "exact" })
      .services,
    f.base,
  );
  assert.equal(f.useWorkspaceServicesResolution("same-path").services, f.remote);
});
