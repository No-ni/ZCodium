import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import { setImmediate as nextTurn } from "node:timers/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

if (process.argv.includes("--child")) {
  await checkSourceAttachmentBarrier();
} else {
  test("Source preparation gates desktop and mobile attachments across retirement", async (t) => {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", fileURLToPath(import.meta.url), "--child"],
      { cwd: fileURLToPath(new URL("../../", import.meta.url)), timeout: 20_000 },
    );
    assert.equal(stderr, "");
    t.diagnostic(stdout.trim());
  });
}

async function checkSourceAttachmentBarrier() {
  const electronStub =
    "data:text/javascript," +
    encodeURIComponent(`
    export const windows = new Map();
    export const BrowserWindow = {
      getAllWindows: () => [...windows.values()],
      fromId: id => windows.get(id),
    };
    export class MessageChannelMain {}
  `);
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      return specifier === "electron"
        ? { url: electronStub, shortCircuit: true }
        : next(specifier, context);
    },
  });
  const { windows } = await import("electron");
  const { createRemoteWorkspaceSessionManager } =
    await import("../../packages/desktop/src/main/desktopRemoteSessions.ts");
  const { buildServerRemoteWorkspaceIdentity } =
    await import("../../packages/shared/src/remote-workspace-identity.ts");
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  const fixtures = [];
  let nextWindow = 0;
  function fixture({ rendererAttachmentReadyTimeoutMs = 1_000 } = {}) {
    const messages = [];
    const delivered = [];
    const channels = [];
    const messageFailures = new Map();
    let rendererDeliveryFailure;
    let acknowledge = true;
    let destroyed = false;
    const windowId = ++nextWindow;
    const webContentsId = windowId + 100;
    const createChild = () => {
      const attachments = new Map();
      return Object.assign(new EventEmitter(), {
        pid: 123,
        postMessage(message, ports = []) {
          messages.push({ child: this, message, ports });
          const failure = messageFailures.get(message.type);
          if (failure) {
            messageFailures.delete(message.type);
            throw new Error(failure);
          }
          if (message.type === "attach-service-port") {
            attachments.set(message.attachmentId, { message, port: ports[0] });
          }
          if (message.type === "detach-service-port") {
            attachments.get(message.attachmentId)?.port.close();
            attachments.delete(message.attachmentId);
          }
          if (message.type === "dispose-remote-workspace-session") {
            for (const [id, attachment] of attachments) {
              if (attachment.message.scope.remoteSessionId !== message.remoteSessionId) continue;
              attachment.port.close();
              attachments.delete(id);
            }
          }
        },
      });
    };
    let child = createChild();
    const hosts = new Map([[webContentsId, child]]);
    const win = {
      id: windowId,
      isDestroyed: () => destroyed,
      webContents: {
        id: webContentsId,
        isDestroyed: () => destroyed,
        send() {},
        postMessage(_channel, payload) {
          if (rendererDeliveryFailure) {
            const failure = rendererDeliveryFailure;
            rendererDeliveryFailure = undefined;
            throw new Error(failure);
          }
          delivered.push(payload);
          if (acknowledge)
            queueMicrotask(() => manager.confirmRendererAttachmentReady(webContentsId, payload));
        },
      },
    };
    windows.set(windowId, win);
    const manager = createRemoteWorkspaceSessionManager({
      windowHostProcessMap: hosts,
      logger: { info() {}, warn() {}, error() {} },
      resolveRemoteAssetDirs: () => ({}),
      createMessageChannel: () => {
        const port1 = Object.assign(new EventEmitter(), { closed: false });
        const port2 = Object.assign(new EventEmitter(), { closed: false });
        const close = () => {
          for (const port of [port1, port2]) {
            if (port.closed) continue;
            port.closed = true;
            port.emit("close");
          }
        };
        port1.close = port2.close = close;
        const channel = { port1, port2 };
        channels.push(channel);
        return channel;
      },
      rendererAttachmentReadyTimeoutMs,
    });
    const descriptor = {
      target: { kind: "docker", container: "synthetic" },
      workspacePath: "/fixture/source",
      workspaceIdentity: buildServerRemoteWorkspaceIdentity({
        serverId: "fixture-source",
        workspacePath: "/fixture/source",
      }),
      remoteSessionId: "fixture-session",
      sourceServerId: "fixture-source",
      configurationMode: "mirror-personal",
      generation: 1,
    };
    const reboundDescriptor = {
      ...descriptor,
      workspacePath: "/fixture/rebound",
      workspaceIdentity: buildServerRemoteWorkspaceIdentity({
        serverId: descriptor.sourceServerId,
        workspacePath: "/fixture/rebound",
      }),
      generation: descriptor.generation + 1,
    };
    function observe(promise) {
      let outcome;
      const result = promise.then(
        (value) => {
          outcome = { value };
          return outcome;
        },
        (error) => {
          outcome = { error };
          return outcome;
        },
      );
      return { result, outcome: () => outcome };
    }
    function connect(requestId = "fixture-connect", currentDescriptor = descriptor) {
      const pending = observe(
        manager.createRemoteWorkspaceSession(
          win,
          currentDescriptor.target,
          requestId,
          currentDescriptor,
        ),
      );
      child.emit("message", {
        type: "remote-workspace-connected",
        requestId,
        descriptor: currentDescriptor,
      });
      return pending;
    }
    function bind(nextDescriptor = reboundDescriptor) {
      const pending = observe(
        manager.bindRemoteWorkspaceSessionContext(
          nextDescriptor.remoteSessionId,
          { workspacePath: nextDescriptor.workspacePath, workspaceIdentity: "untrusted-ui-key" },
          webContentsId,
        ),
      );
      return {
        ...pending,
        descriptor: nextDescriptor,
        request: messages.findLast(
          (item) => item.child === child && item.message.type === "bind-remote-workspace-context",
        )?.message,
      };
    }
    function bindResponse(pending, overrides = {}, respondingChild = child) {
      respondingChild.emit("message", {
        type: "remote-workspace-context-bind-ready",
        requestId: pending.request.requestId,
        remoteSessionId: pending.descriptor.remoteSessionId,
        workspacePath: pending.descriptor.workspacePath,
        workspaceIdentity: pending.descriptor.workspaceIdentity,
        generation: pending.descriptor.generation,
        ...overrides,
      });
    }
    function bindFailed(
      pending,
      error = "synthetic Host preparation failure",
      respondingChild = child,
    ) {
      respondingChild.emit("message", {
        type: "remote-workspace-context-bind-failed",
        requestId: pending.request.requestId,
        remoteSessionId: pending.descriptor.remoteSessionId,
        error,
      });
    }
    function finishProvisioning(executingChild = child, status = "applied") {
      const execution = messages.findLast(
        (item) =>
          item.child === executingChild && item.message.type === "provider-provisioning-execute",
      );
      assert.ok(execution, "provisioning execution was admitted");
      executingChild.emit("message", {
        type: "provider-provisioning-execution-result",
        requestId: execution.message.requestId,
        environmentKey: execution.message.environmentKey,
        status,
      });
    }
    function attachMobile(scope = descriptor) {
      return manager.attachRemoteWorkspaceSessionHost({
        windowId,
        remoteSessionId: scope.remoteSessionId,
        workspacePath: scope.workspacePath,
        workspaceIdentity: scope.workspaceIdentity,
        workspaceKey: scope.workspaceIdentity,
        clientMode: "web-remote-replayable",
      });
    }
    const value = {
      manager,
      win,
      messages,
      descriptor,
      reboundDescriptor,
      connect,
      bind,
      bindResponse,
      bindFailed,
      finishProvisioning,
      attachMobile,
      delivered,
      channels,
      failMessage(type, failure = "synthetic transport failure") {
        messageFailures.set(type, failure);
      },
      failRendererDelivery() {
        rendererDeliveryFailure = "synthetic renderer delivery failure";
      },
      closeWindow() {
        destroyed = true;
        manager.disposeRemoteWorkspaceSessionsForWindow(webContentsId);
      },
      currentChild: () => child,
      replaceHost() {
        const previous = child;
        child = createChild();
        hosts.set(webContentsId, child);
        manager.reattachRemoteWorkspaceSessionsForWindow(win, "fixture:Host-replaced");
        return previous;
      },
      holdRenderer() {
        acknowledge = false;
      },
      readyRenderer(payload = delivered.at(-1)) {
        assert.ok(payload);
        manager.confirmRendererAttachmentReady(webContentsId, payload);
      },
      attachable: () =>
        manager.hasAttachableRemoteSession({
          webContentsId,
          remoteSessionId: descriptor.remoteSessionId,
        }),
      attachmentCount: () =>
        messages.filter((item) => item.message.type === "attach-service-port").length,
    };
    fixtures.push(value);
    return value;
  }
  try {
    {
      const f = fixture();
      const pending = f.connect();
      assert.equal(f.attachable(), false, "initial provisioning is not attachable");
      assert.throws(f.attachMobile, (error) => error.code === "REMOTE_SESSION_OFFLINE");
      assert.equal(f.attachmentCount(), 0);
      f.finishProvisioning();
      assert.equal((await pending.result).value, "fixture-session");
      assert.equal(f.attachable(), true);
      f.attachMobile().port.close();
      assert.deepEqual(
        f.messages
          .filter((item) => item.message.type === "attach-service-port")
          .map((item) => item.message.clientMode),
        ["desktop-continuous", "web-remote-replayable"],
      );
    }
    {
      const f = fixture();
      f.holdRenderer();
      const pending = f.connect();
      f.finishProvisioning();
      await nextTurn();
      assert.equal(f.attachmentCount(), 1);
      assert.equal(f.attachable(), false, "renderer ready is part of initial admission");
      assert.throws(f.attachMobile, (error) => error.code === "REMOTE_SESSION_OFFLINE");
      f.readyRenderer();
      assert.equal((await pending.result).value, "fixture-session");
      assert.equal(f.attachable(), true);
    }
    for (const action of [
      "cancel",
      "dispose",
      "connection-close",
      "host-exit",
      "window-close",
      "shutdown",
    ]) {
      const f = fixture();
      const pending = f.connect();
      if (action === "cancel")
        f.manager.cancelPendingRemoteWorkspaceSessionsForWindow(
          f.win.webContents.id,
          "fixture",
          "fixture-connect",
        );
      if (action === "dispose") f.manager.disposeRemoteWorkspaceSession("fixture-session");
      if (action === "connection-close")
        f.currentChild().emit("message", {
          type: "remote-workspace-closed",
          remoteSessionId: "fixture-session",
          reason: "connection-closed",
        });
      if (action === "host-exit") f.currentChild().emit("exit", 1);
      if (action === "window-close")
        f.manager.disposeRemoteWorkspaceSessionsForWindow(f.win.webContents.id);
      if (action === "shutdown") await f.manager.disposeAllAndWaitForAppShutdown("fixture");
      await nextTurn();
      assert.ok(pending.outcome()?.error, `${action} settles the pending connection`);
      f.finishProvisioning();
      await nextTurn();
      assert.equal(f.attachmentCount(), 0, `${action} cannot create late ports`);
      assert.equal(f.attachable(), false);
    }
    {
      const f = fixture();
      const old = f.connect("old");
      const oldChild = f.replaceHost();
      const next = f.connect("next", { ...f.descriptor, remoteSessionId: "next-session" });
      oldChild.emit("exit", 1);
      await nextTurn();
      assert.ok(old.outcome()?.error);
      assert.equal(next.outcome(), undefined, "old Host exit cannot reject a new Host request");
      f.finishProvisioning();
      assert.equal((await next.result).value, "next-session");
    }
    {
      const f = fixture();
      const old = f.connect("old");
      f.manager.disposeRemoteWorkspaceSession("fixture-session");
      const next = f.connect("next");
      f.finishProvisioning(f.currentChild(), "failed");
      await nextTurn();
      f.finishProvisioning();
      assert.equal((await next.result).value, "fixture-session");
      assert.ok((await old.result).error);
      assert.equal(f.attachable(), true, "retired failure cannot erase replacement route");
    }
    {
      const f = fixture();
      const connecting = f.connect();
      f.finishProvisioning();
      await connecting.result;
      const oldRenderer = f.delivered.at(-1);
      const mobile = f.attachMobile();
      f.holdRenderer();
      const binding = f.bind();
      assert.ok(binding.request);
      assert.equal(f.attachable(), false, "rebind immediately retires attachment admission");
      assert.equal(mobile.port.closed, true, "rebind retires existing mobile ports");
      f.readyRenderer(oldRenderer);
      await nextTurn();
      assert.equal(binding.outcome(), undefined, "old renderer ACK cannot prove Host ready");
      assert.equal(f.delivered.length, 1, "no new renderer port before Host ready");
      assert.throws(
        () => f.attachMobile(f.reboundDescriptor),
        (error) => error.code === "REMOTE_SESSION_OFFLINE",
      );
      for (const invalid of [
        { requestId: "retired-request" },
        { remoteSessionId: "another-session" },
        { generation: 1 },
        { workspacePath: "/another" },
        { workspaceIdentity: "wrong" },
      ]) {
        f.bindResponse(binding, invalid);
        await nextTurn();
        assert.equal(f.delivered.length, 1);
      }
      f.bindResponse(binding);
      await nextTurn();
      assert.equal(f.delivered.length, 2);
      assert.equal(f.attachable(), false, "Host ready alone is insufficient before renderer ready");
      f.bindResponse(binding);
      assert.equal(f.delivered.length, 2, "duplicate Host ready cannot create another port");
      f.readyRenderer();
      assert.deepEqual(await binding.result, { value: undefined });
      assert.equal(f.attachable(), true);
      f.attachMobile(f.reboundDescriptor).port.close();
      assert.equal(
        f.messages.findLast((item) => item.message.type === "attach-service-port").message.scope
          .workspaceIdentity,
        f.reboundDescriptor.workspaceIdentity,
      );
    }
    {
      const f = fixture();
      const connecting = f.connect();
      f.finishProvisioning();
      await connecting.result;
      const binding = f.bind();
      f.bindFailed(binding);
      assert.match((await binding.result).error.message, /synthetic Host preparation failure/);
      assert.equal(f.attachable(), false);
      f.bindResponse(binding);
      await nextTurn();
      assert.equal(f.delivered.length, 1, "failed bind cannot create late ports");
    }
    for (const phase of ["Host", "renderer"]) {
      for (const action of [
        "cancel",
        "dispose",
        "connection-close",
        "host-exit",
        "window-close",
        "shutdown",
        "host-replaced",
      ]) {
        const f = fixture();
        const connecting = f.connect();
        f.finishProvisioning();
        await connecting.result;
        f.holdRenderer();
        const binding = f.bind();
        if (phase === "renderer") {
          f.bindResponse(binding);
          await nextTurn();
        }
        const originalChild = f.currentChild();
        if (action === "cancel")
          f.manager.cancelPendingRemoteWorkspaceSessionsForWindow(
            f.win.webContents.id,
            "fixture",
            binding.request.requestId,
          );
        if (action === "dispose") f.manager.disposeRemoteWorkspaceSession("fixture-session");
        if (action === "connection-close")
          originalChild.emit("message", {
            type: "remote-workspace-closed",
            remoteSessionId: "fixture-session",
            reason: "connection-closed",
          });
        if (action === "host-exit") originalChild.emit("exit", 1);
        if (action === "window-close") f.closeWindow();
        if (action === "shutdown") await f.manager.disposeAllAndWaitForAppShutdown("fixture");
        if (action === "host-replaced") f.replaceHost();
        await nextTurn();
        assert.ok(binding.outcome()?.error, `${phase}/${action} settles rebind`);
        const count = f.attachmentCount();
        f.bindResponse(binding, {}, originalChild);
        f.readyRenderer();
        await nextTurn();
        assert.equal(f.attachmentCount(), count, `${phase}/${action} cannot create late ports`);
        assert.equal(f.attachable(), false);
      }
    }
    for (const failure of ["bind-transport", "renderer-transport", "renderer-delivery"]) {
      const f = fixture();
      const connecting = f.connect();
      f.finishProvisioning();
      await connecting.result;
      if (failure === "bind-transport") f.failMessage("bind-remote-workspace-context");
      const binding = f.bind();
      if (failure === "renderer-transport") f.failMessage("attach-service-port");
      if (failure === "renderer-delivery") f.failRendererDelivery();
      if (failure !== "bind-transport") f.bindResponse(binding);
      const result = await binding.result;
      assert.ok(result.error, `${failure} settles caller`);
      assert.equal(f.attachable(), false);
    }
    await nextTurn();
    assert.deepEqual(unhandled, []);
    process.stdout.write(
      "Source attachment: initial and rebind Host/renderer barriers, both delivery modes, retirement paths, stale generation and transport failures passed; unhandledRejection=0\n",
    );
  } finally {
    for (const f of fixtures) await f.manager.disposeAllAndWaitForAppShutdown("fixture cleanup");
    windows.clear();
    process.off("unhandledRejection", listener);
    hooks.deregister();
  }
}
