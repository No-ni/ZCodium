import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import { setImmediate as nextTurn } from "node:timers/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

if (process.argv.includes("--child")) {
  await checkReconnectLifecycle();
} else {
  test("Main reconnect settles all lifecycle paths without unhandled rejections", async (t) => {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", fileURLToPath(import.meta.url), "--child"],
      { cwd: fileURLToPath(new URL("../../", import.meta.url)), timeout: 15_000 },
    );
    assert.equal(stderr, "");
    t.diagnostic(stdout.trim());
  });
}

async function checkReconnectLifecycle() {
  // Only replace Electron shell objects; all manager/reconnect logic is production source.
  const electronStub =
    "data:text/javascript," +
    encodeURIComponent(
      "export const BrowserWindow = { getAllWindows: () => [] }; export class MessageChannelMain {}",
    );
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      return specifier === "electron"
        ? { url: electronStub, shortCircuit: true }
        : next(specifier, context);
    },
  });
  const { createRemoteWorkspaceSessionManager } =
    await import("../../packages/desktop/src/main/desktopRemoteSessions.ts");
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  const messages = [];
  function createChild() {
    const instance = Object.assign(new EventEmitter(), {
      pid: 123,
      postMessage(message) {
        messages.push(message);
        if (message.type === "provider-provisioning-execute")
          queueMicrotask(() =>
            instance.emit("message", {
              type: "provider-provisioning-execution-result",
              requestId: message.requestId,
              environmentKey: message.environmentKey,
              status: "applied",
            }),
          );
      },
    });
    return instance;
  }
  let child = createChild();
  const hosts = new Map([[22, child]]);
  const win = {
    id: 11,
    isDestroyed: () => false,
    webContents: {
      id: 22,
      isDestroyed: () => false,
      send() {},
      postMessage(_channel, payload) {
        queueMicrotask(() => manager.confirmRendererAttachmentReady(22, payload));
      },
    },
  };
  const manager = createRemoteWorkspaceSessionManager({
    windowHostProcessMap: hosts,
    logger: { info() {}, warn() {}, error() {} },
    resolveRemoteAssetDirs: () => ({}),
    createMessageChannel: () => ({ port1: { close() {} }, port2: { close() {} } }),
  });
  const params = {
    target: { kind: "docker", container: "synthetic" },
    workspacePath: "C:/synthetic",
    workspaceIdentity: "synthetic",
  };
  const reconnect = (requestId) =>
    manager.reconnectBotRemoteWorkspaceSession(win, { ...params, requestId });
  const failed = (requestId, error) =>
    child.emit("message", { type: "remote-workspace-connect-failed", requestId, error });
  try {
    for (let i = 0; i < 3; i++) {
      const requestId = `synthetic-${i}`;
      const result = manager
        .reconnectBotRemoteWorkspaceSession(win, {
          ...params,
          requestId,
        })
        .catch((error) => error);
      child.emit("message", {
        type: "remote-workspace-connect-failed",
        requestId,
        error: `synthetic failure ${i}`,
      });
      assert.equal((await result).message, `synthetic failure ${i}`);
      await nextTurn();
    }
    const cancelled = reconnect("cancelled");
    const cancelResult = cancelled.catch((error) => error);
    assert.equal(reconnect("deduplicated"), cancelled);
    manager.cancelPendingRemoteWorkspaceSessionsForWindow(
      22,
      "synthetic cancellation",
      "cancelled",
    );
    assert.equal(messages.at(-1).type, "cancel-remote-workspace-connect");
    failed("cancelled", "synthetic cancellation");
    assert.equal((await cancelResult).message, "synthetic cancellation");
    await nextTurn();

    const exited = reconnect("exited");
    const exitResult = exited.catch((error) => error);
    child.emit("exit", 1);
    assert.match((await exitResult).message, /Local Host 已退出/);
    await nextTurn();

    // 合成 Host 恢复后，实际 manager 仍走 provisioning、attachment 与 ready 顺序。
    child = createChild();
    hosts.set(22, child);
    const success = reconnect("success");
    assert.notEqual(success, exited);
    assert.equal(reconnect("success-deduplicated"), success);
    child.emit("message", {
      type: "remote-workspace-connected",
      requestId: "success",
      descriptor: {
        ...params,
        remoteSessionId: "synthetic-session",
        generation: 1,
      },
    });
    assert.equal(await success, "synthetic-session");
    assert.equal(await reconnect("cached"), "synthetic-session");
    manager.disposeRemoteWorkspaceSession("synthetic-session");
    const retry = reconnect("after-success");
    const retryResult = retry.catch((error) => error);
    assert.notEqual(retry, success);
    assert.equal(messages.at(-1).requestId, "after-success");
    failed("after-success", "synthetic retry failure");
    assert.equal((await retryResult).message, "synthetic retry failure");
    await nextTurn();

    const closing = reconnect("shutdown").catch((error) => error);
    await manager.disposeAllAndWaitForAppShutdown("synthetic shutdown");
    assert.match((await closing).message, /应用正在退出/);
    await assert.rejects(reconnect("after-shutdown"), /应用正在退出/);
    await nextTurn();
    assert.deepEqual(unhandled, []);
    process.stdout.write(
      "Main reconnect: failure, cancellation, Host exit, success, deduplication, retry and shutdown passed; unhandledRejection=0\n",
    );
  } finally {
    await manager.disposeAllAndWaitForAppShutdown("synthetic cleanup");
    process.off("unhandledRejection", listener);
    hooks.deregister();
  }
}
