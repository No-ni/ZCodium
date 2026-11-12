import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { SourceServerConnectionManager } from "../../packages/desktop/src/host/sourceServerConnectionManager.ts";
import { createWindowHostAttachmentRegistry } from "../../packages/desktop/src/host/windowHostAttachmentRegistry.ts";
import {
  exposeWindowHostAttachmentServices,
  resolveWindowHostServiceExposurePolicy,
} from "../../packages/desktop/src/host/windowHostAttachmentRpcPolicy.ts";
import { IMcpSyncService, ISettingsSyncService } from "../../packages/services/src/index.ts";
import { ServiceChannels, ZCODE_COMPATIBILITY_MANIFEST } from "@zcode/shared";

test("settings scope never connects or falls back when the device is offline", async () => {
  let connections = 0;
  const manager = new SourceServerConnectionManager({
    directory: {
      onDidChange: () => ({ dispose() {} }),
      snapshot: async () => ({ generation: 1, profiles: [] }),
    },
    connectTransport: async () => {
      connections += 1;
      throw new Error("unexpected connection");
    },
  });
  assert.throws(() => manager.getSettingsScope("offline"), /offline/);
  assert.equal(connections, 0);
  await manager.dispose();
});

test("settings attachment is Desktop-only and closes by device without touching task scopes", () => {
  const closed = [];
  const registry = createWindowHostAttachmentRegistry({
    resolveScope: () => ({ services: {}, generation: 1 }),
    expose: ({ attachmentId }) => ({ dispose: () => closed.push(attachmentId) }),
  });
  const params = (attachmentId, scope) => ({
    requestId: attachmentId,
    attachmentId,
    clientMode: "desktop-continuous",
    scope,
    port: { once() {} },
  });
  assert.throws(
    () =>
      registry.attach({
        ...params("mobile", { kind: "source-settings", sourceServerId: "source" }),
        clientMode: "web-remote-replayable",
      }),
    /Desktop-only/,
  );
  registry.attach(params("settings", { kind: "source-settings", sourceServerId: "source" }));
  registry.attach(
    params("task", {
      kind: "remote",
      remoteSessionId: "session",
      workspacePath: "/fixture",
      workspaceIdentity: "fixture-identity",
    }),
  );
  registry.detachSourceSettingsAttachments("source");
  assert.deepEqual(closed, ["settings"]);
  assert.equal(registry.size(), 1);
  registry.dispose();
});

test("Host settings port excludes task control and has a generation-scoped owner", async () => {
  const host = await readFile(
    new URL("../../packages/desktop/src/host/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(host, /attachmentScope\.kind !== "source-settings"/);
  assert.match(host, /scope\.kind === "source-settings"/);
  assert.match(host, /getSettingsScope\(scope\.sourceServerId\)/);
  assert.match(host, /detachSourceSettingsAttachments/);
  assert.match(host, /createSourceConnectionManager\(sourceServerDirectory\)/);
});

test("file and settings capabilities are wired through the platform bridge", async () => {
  const preload = await readFile(
    new URL("../../packages/desktop/src/preload/index.ts", import.meta.url),
    "utf8",
  );
  const platform = await readFile(
    new URL("../../packages/desktop/src/renderer/src/desktopPlatform.ts", import.meta.url),
    "utf8",
  );
  for (const method of [
    "selectDirectories",
    "getFileApplications",
    "openFileWithApplication",
    "materializeWorkflowArtifactFile",
    "requestSourceSettingsAttachment",
  ]) {
    assert.match(preload, new RegExp(`${method}:`));
    assert.match(platform, new RegExp(`${method}:`));
  }
});

test("mobile exposure rejects newly registered device controls and batch configuration sync", async () => {
  const policy = resolveWindowHostServiceExposurePolicy("web-remote-replayable");
  for (const channel of [
    ServiceChannels.SourceServerManagement,
    ServiceChannels.ProviderProvisioningStatus,
    ServiceChannels.ProviderProvisioningTarget,
    ServiceChannels.SkillSync,
    ServiceChannels.PluginSync,
    "future-device-control",
  ]) {
    assert.equal(policy.allowedChannels.has(channel), false, channel);
  }
  assert.equal(policy.allowedChannels.has(ServiceChannels.Terminal), true);
  assert.equal(resolveWindowHostServiceExposurePolicy("desktop-continuous"), undefined);
  const calls = [];
  const mcp = {
    loadMcpFromUserDirectory: async (...args) => {
      calls.push(args);
      return "fixture";
    },
  };
  let exposed;
  exposeWindowHostAttachmentServices({
    server: {},
    clientMode: "web-remote-replayable",
    services: {
      getOptional: (descriptor) => (descriptor === IMcpSyncService ? mcp : undefined),
      exposeOnChannelServer: (_server, overrides, exposure) => {
        exposed = { overrides, exposure };
      },
    },
  });
  const scoped = exposed.overrides.get(IMcpSyncService.channelName);
  assert.equal(await scoped.loadMcpFromUserDirectory("fixture"), "fixture");
  assert.deepEqual(calls, [["fixture"]]);
  await assert.rejects(scoped.futureBatchImport(), { kind: "feature_disabled" });
  assert.equal(scoped.then, undefined);
  assert.equal(scoped.onFutureEvent, undefined);
  assert.equal(exposed.exposure, policy);
});

test("mobile first-run lifecycle uses the same Host owner and leaves migration methods disabled", async () => {
  const calls = [];
  const owner = {
    handled: false,
    async getFirstRunPromptState() {
      calls.push("get");
      return { handled: this.handled };
    },
    async markFirstRunPromptHandled() {
      calls.push("mark");
      this.handled = true;
    },
  };
  let exposed;
  exposeWindowHostAttachmentServices({
    server: {},
    clientMode: "web-remote-replayable",
    services: {
      getOptional: (descriptor) => (descriptor === ISettingsSyncService ? owner : undefined),
      exposeOnChannelServer: (_server, overrides, exposure) => {
        exposed = { overrides, exposure };
      },
    },
  });
  assert.equal(exposed.exposure.allowedChannels.has(ServiceChannels.SettingsSync), true);
  const scoped = exposed.overrides.get(ISettingsSyncService.channelName);
  assert.deepEqual(await scoped.getFirstRunPromptState(), { handled: false });
  await scoped.markFirstRunPromptHandled();
  assert.deepEqual(await scoped.getFirstRunPromptState(), { handled: true });
  assert.deepEqual(calls, ["get", "mark", "get"]);
  for (const method of [
    "detect",
    "importSelected",
    "getClaudeAgentsFileMigrationStatus",
    "copyClaudeAgentsFileToZcodeAgentsFile",
    "futureBatchImport",
  ]) {
    await assert.rejects(scoped[method](), { kind: "feature_disabled" });
  }
  assert.deepEqual(calls, ["get", "mark", "get"]);
  assert.equal(scoped.then, undefined);
  assert.equal(scoped.onFutureEvent, undefined);
  assert.equal(scoped[Symbol.iterator], undefined);
});

test("mobile scopes the selected settings override while Desktop keeps the original capability", async () => {
  const owner = { getFirstRunPromptState: async () => ({ handled: true }) };
  const overrides = new Map([[ISettingsSyncService.channelName, owner]]);
  const exposures = [];
  const services = {
    getOptional: () => {
      throw new Error("an explicit override must keep its owner");
    },
    exposeOnChannelServer: (_server, selected, policy) => {
      exposures.push({ selected, policy });
    },
  };
  // MCP remains absent without replacing the explicit settings owner.
  services.getOptional = (descriptor) => {
    assert.equal(descriptor, IMcpSyncService);
    return undefined;
  };
  exposeWindowHostAttachmentServices({
    server: {},
    services,
    clientMode: "web-remote-replayable",
    overrides,
  });
  const scoped = exposures[0].selected.get(ISettingsSyncService.channelName);
  assert.notEqual(scoped, owner);
  assert.deepEqual(await scoped.getFirstRunPromptState(), { handled: true });
  await assert.rejects(scoped.detect(), { kind: "feature_disabled" });
  assert.equal(overrides.get(ISettingsSyncService.channelName), owner);
  exposeWindowHostAttachmentServices({
    server: {},
    services,
    clientMode: "desktop-continuous",
    overrides,
  });
  assert.equal(exposures[1].selected, overrides);
  assert.equal(exposures[1].policy, undefined);
});

function onlineFixture(disposeFirst = async () => {}) {
  const profile = {
    profileId: "profile",
    generation: 1,
    sourceServerId: "source",
    displayName: "Fixture",
    target: { kind: "docker", container: "fixture" },
    configurationMode: "target",
    createdAt: 1,
  };
  const connections = [];
  const manager = new SourceServerConnectionManager({
    directory: {
      onDidChange: () => ({ dispose() {} }),
      snapshot: async () => ({ generation: 1, profiles: [profile], servers: [] }),
      assertCurrent: async () => profile,
      recordHandshake: async () => profile,
    },
    connectTransport: async () => ({
      backend: {},
      dispose: connections.length === 0 ? disposeFirst : async () => {},
    }),
    connectRpc: async () => {
      const listeners = new Set();
      let closed = false;
      const connection = {
        serverInfo: { serverId: "source", compatibility: ZCODE_COMPATIBILITY_MANIFEST },
        services: {},
        get isClosed() {
          return closed;
        },
        onDidClose: (listener) => {
          listeners.add(listener);
          return { dispose: () => listeners.delete(listener) };
        },
        dispose() {
          closed = true;
        },
        close() {
          closed = true;
          for (const listener of listeners) listener();
        },
      };
      connections.push(connection);
      return connection;
    },
  });
  return { manager, connections, profile, target: profile.target };
}

test("reconnection with the same Profile gets a new physical settings generation", async () => {
  const fixture = onlineFixture();
  const first = await fixture.manager.retain(fixture.profile, fixture.target);
  const old = fixture.manager.getSettingsScope("source");
  fixture.connections[0].close();
  assert.throws(() => fixture.manager.getSettingsScope("source"), /offline/);
  const second = await fixture.manager.retain(fixture.profile, fixture.target);
  const next = fixture.manager.getSettingsScope("source");
  assert.notEqual(next.generation, old.generation);
  assert.notEqual(next.services, old.services);
  await Promise.all([first.dispose(), second.dispose(), fixture.manager.dispose()]);
});

test("Host shutdown shares its barrier and waits for an already offline transport", async () => {
  const release = Promise.withResolvers();
  const fixture = onlineFixture(() => release.promise);
  await fixture.manager.retain(fixture.profile, fixture.target);
  fixture.connections[0].close();
  let finished = false;
  const closing = fixture.manager.dispose();
  assert.equal(fixture.manager.dispose(), closing);
  closing.then(() => {
    finished = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  release.resolve();
  await closing;
  assert.equal(finished, true);
});
