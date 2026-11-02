import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { tsImport } from "tsx/esm/api";

const shared = await tsImport("../../packages/shared/src/index.ts", import.meta.url);
const provisioning = await tsImport(
  "../../packages/desktop/src/main/providerProvisioningEnvironmentCoordinator.ts",
  import.meta.url,
);
const source = await readFile(
  new URL("../../packages/desktop/src/main/desktopRemoteSessions.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const require = createRequire(import.meta.url);

function fixture() {
  const posts = [];
  const logs = [];
  const child = new EventEmitter();
  child.pid = 100;
  let execution = { status: "applied" };
  let manager;
  const target = { kind: "docker", container: "fixture" };
  const descriptor = {
    remoteSessionId: "session",
    sourceServerId: "source",
    target,
    workspacePath: "/fixture",
    workspaceIdentity: "fixture-identity",
    generation: 1,
    configurationMode: "mirror-personal",
  };
  const win = {
    id: 41,
    isDestroyed: () => false,
    webContents: {
      id: 41,
      isDestroyed: () => false,
      send() {},
      postMessage(_channel, payload) {
        queueMicrotask(() => manager.confirmRendererAttachmentReady(41, payload));
      },
    },
  };
  const hostMap = new Map([[41, child]]);
  child.postMessage = (message) => {
    posts.push(message);
    if (message.type === shared.HostMessageTypes.ConnectRemoteWorkspace) {
      queueMicrotask(() =>
        child.emit("message", {
          type: shared.HostResponseTypes.RemoteWorkspaceConnected,
          requestId: message.requestId,
          descriptor,
        }),
      );
    }
    if (message.type === shared.HostMessageTypes.ProviderProvisioningExecute) {
      const result = execution;
      queueMicrotask(() =>
        child.emit("message", {
          type: shared.HostResponseTypes.ProviderProvisioningExecutionResult,
          requestId: message.requestId,
          environmentKey: message.environmentKey,
          ...result,
        }),
      );
    }
  };
  // Only Electron transport is substituted; current Main routing and shared schemas execute unchanged.
  const module = { exports: {} };
  const imports = {
    electron: { BrowserWindow: { getAllWindows: () => [win] } },
    "@zcode/shared": shared,
    "./providerProvisioningEnvironmentCoordinator.js": provisioning,
  };
  new Function("require", "exports", "module", compiled)(
    (id) => {
      if (id === "node:crypto") return require(id);
      assert.ok(Object.hasOwn(imports, id), `Unexpected Main dependency: ${id}`);
      return imports[id];
    },
    module.exports,
    module,
  );
  const coordinator = new provisioning.ProviderProvisioningEnvironmentCoordinator({
    now: () => 42,
  });
  manager = module.exports.createRemoteWorkspaceSessionManager({
    logger: Object.fromEntries(
      ["info", "warn", "error"].map((level) => [level, (...args) => logs.push(args)]),
    ),
    windowHostProcessMap: hostMap,
    resolveRemoteAssetDirs: () => ({}),
    createMessageChannel: () => ({ port1: { close() {} }, port2: { close() {} } }),
    providerProvisioningCoordinator: coordinator,
  });
  return {
    child,
    coordinator,
    logs,
    posts,
    hostMap,
    manager,
    connect: () => manager.createRemoteWorkspaceSession(win, target, "connect", descriptor),
    result: (result) => {
      execution = result;
    },
  };
}

test("Main records failed user retries with a fixed code instead of success", async () => {
  const current = fixture();
  try {
    await current.connect();
    current.result({
      status: "failed",
      errorCode: "target-write-failed",
      error: "fixture-private-material",
    });
    assert.deepEqual(await current.coordinator.retry("source"), {
      lane: "present",
      running: false,
      lastResult: { at: 42, outcome: "failed", errorCode: "target-write-failed" },
    });
    assert.doesNotMatch(JSON.stringify(current.logs), /fixture-private-material/);
    current.result({ status: "already-applied" });
    assert.deepEqual(await current.coordinator.retry("source"), {
      lane: "present",
      running: false,
      lastResult: { at: 42, outcome: "success" },
    });
  } finally {
    await current.manager.disposeAllAndWaitForAppShutdown("fixture");
  }
});

test("Main fails unsupported and rollback-failed retries without free-text diagnostics", async () => {
  for (const status of ["unsupported", "rollback_failed"]) {
    const current = fixture();
    try {
      await current.connect();
      current.result({ status });
      const result = await current.coordinator.retry("source");
      assert.equal(result.lastResult.outcome, "failed");
      assert.equal(
        result.lastResult.errorCode,
        status === "unsupported" ? "capability-unavailable" : "target-apply-failed",
      );
    } finally {
      await current.manager.disposeAllAndWaitForAppShutdown("fixture");
    }
  }
});

test("Main does not send delayed lane results to a replacement Host", async () => {
  const current = fixture();
  try {
    await current.connect();
    current.child.emit("message", {
      type: shared.HostResponseTypes.ProviderProvisioningLaneRequest,
      requestId: "status",
      sourceServerId: "source",
      action: "read",
    });
    current.hostMap.set(41, { pid: 101 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      current.posts.filter(
        (message) => message.type === shared.HostMessageTypes.ProviderProvisioningLaneResult,
      ).length,
      0,
    );
  } finally {
    await current.manager.disposeAllAndWaitForAppShutdown("fixture");
  }
});
