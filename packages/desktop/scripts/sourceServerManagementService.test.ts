import assert from "node:assert/strict";
import { test } from "node:test";
import { Emitter } from "@zcode/rpc";
import { ZCODE_COMPATIBILITY_MANIFEST, type AppSettings } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import type { SourceServerTransport } from "@zcode/server/source-server";
import { SourceServerDirectory } from "../src/host/sourceServerDirectory.js";
import { SourceServerConnectionManager } from "../src/host/sourceServerConnectionManager.js";
import { createSourceServerManagementService } from "../src/host/sourceServerManagementService.js";
import type { SourceServerRpcConnection } from "../src/host/sourceServerRpc.js";

function fixture() {
  let settings = {} as AppSettings;
  let sourceId = "source-a";
  const closed: string[] = [];
  const directory = new SourceServerDirectory({
    settingService: {
      get: async () => structuredClone(settings),
      update: async (patch) => {
        settings = { ...settings, ...structuredClone(patch) };
      },
    },
    credentialService: { load: async () => null, save: async () => {}, delete: async () => {} },
    createId: () => "profile-a",
  });
  const manager = new SourceServerConnectionManager({
    directory,
    connectTransport: async () =>
      ({ backend: {}, dispose: async () => {} }) as SourceServerTransport,
    connectRpc: async () => {
      const id = sourceId;
      const changes = new Emitter<void>();
      let disposed = false;
      return {
        serverInfo: {
          protocolVersion: 1,
          serverId: id,
          version: "3.15.1",
          authRequired: true,
          capabilities: { desktopContinuous: true, websocketRpc: true, sourceServer: true },
          compatibility: ZCODE_COMPATIBILITY_MANIFEST,
        },
        services: {} as IServiceAccessor,
        get isClosed() {
          return disposed;
        },
        onDidClose: changes.event,
        dispose() {
          if (disposed) return;
          disposed = true;
          closed.push(id);
          changes.fire();
        },
      } satisfies SourceServerRpcConnection;
    },
  });
  const service = createSourceServerManagementService({ directory, manager });
  return {
    directory,
    manager,
    service,
    closed,
    setSourceId: (id: string) => {
      sourceId = id;
    },
    target: { kind: "ssh" as const, host: "example.invalid", username: "fixture" },
  };
}

test("Source management exposes versioned facts and only confirms the displayed installation", async () => {
  const { directory, manager, service, target, setSourceId } = fixture();
  try {
    assert.deepEqual(await service.getCapabilities(), { version: 1 });
    const initial = await directory.ensureProfile(target);
    await service.connectProfile({ profileId: initial.profileId, generation: initial.generation });
    const bound = await directory.assertCurrent(initial);
    await service.disconnectSource({ sourceServerId: "source-a" });
    setSourceId("source-b");
    await assert.rejects(
      service.connectProfile({ profileId: bound.profileId, generation: bound.generation }),
    );
    const pending = await service.getSnapshot();
    assert.equal(pending.states[0]?.state, "identity-change-pending");
    assert.equal(pending.directory.profiles[0]?.sourceServerId, "source-a");
    await assert.rejects(
      service.confirmIdentityChange({
        profileId: bound.profileId,
        generation: bound.generation,
        expectedSourceServerId: "source-c",
      }),
      /stale/,
    );
    const accepted = await service.confirmIdentityChange({
      profileId: bound.profileId,
      generation: bound.generation,
      expectedSourceServerId: "source-b",
    });
    assert.equal(accepted.directory.profiles[0]?.sourceServerId, "source-b");
    assert.equal(accepted.directory.profiles[0]?.generation, bound.generation + 1);
    assert.equal(accepted.states[0]?.state, "online");
  } finally {
    service.dispose();
    await manager.dispose();
    directory.dispose();
  }
});

test("a changed installation during confirmation is not silently accepted", async () => {
  const { directory, manager, service, target, setSourceId } = fixture();
  try {
    const profile = await directory.ensureProfile(target);
    const bound = await directory.recordHandshake(profile, {
      serverId: "source-a",
      version: "3.15.1",
    });
    setSourceId("source-b");
    await assert.rejects(
      service.connectProfile({ profileId: bound.profileId, generation: bound.generation }),
    );
    setSourceId("source-c");
    await assert.rejects(
      service.confirmIdentityChange({
        profileId: bound.profileId,
        generation: bound.generation,
        expectedSourceServerId: "source-b",
      }),
    );
    assert.equal((await directory.snapshot()).profiles[0]?.sourceServerId, "source-a");
    assert.equal(manager.listStates()[0]?.pendingSourceServerId, "source-c");
  } finally {
    service.dispose();
    await manager.dispose();
    directory.dispose();
  }
});

test("closed Source management rejects every command without changing its Directory", async () => {
  const { directory, manager, service, target } = fixture();
  try {
    const profile = await directory.ensureProfile(target);
    const before = await directory.snapshot();
    service.dispose();
    const operation = { profileId: profile.profileId, generation: profile.generation };
    await assert.rejects(service.getCapabilities());
    await assert.rejects(service.getSnapshot());
    await assert.rejects(service.saveProfile({ ...profile, displayName: "Changed" }));
    await assert.rejects(service.removeProfile(operation));
    await assert.rejects(service.connectProfile(operation));
    await assert.rejects(
      service.confirmIdentityChange({ ...operation, expectedSourceServerId: "source-b" }),
    );
    await assert.rejects(service.disconnectSource({ sourceServerId: "source-a" }));
    assert.deepEqual(await directory.snapshot(), before);
  } finally {
    service.dispose();
    await manager.dispose();
    directory.dispose();
  }
});
