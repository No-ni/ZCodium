import assert from "node:assert/strict";
import { test } from "node:test";
import { Emitter } from "@zcode/rpc";
import { ZCODE_COMPATIBILITY_MANIFEST, type AppSettings } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import type { SourceServerTransport } from "@zcode/server/source-server";
import { SourceServerDirectory } from "../src/host/sourceServerDirectory.js";
import { SourceServerConnectionManager } from "../src/host/sourceServerConnectionManager.js";
import type { SourceServerRpcConnection } from "../src/host/sourceServerRpc.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  let settings = {} as AppSettings;
  let nextId = 0;
  const directory = new SourceServerDirectory({
    settingService: {
      get: async () => structuredClone(settings),
      update: async (patch) => {
        settings = { ...settings, ...structuredClone(patch) };
      },
    },
    credentialService: { load: async () => null, save: async () => {}, delete: async () => {} },
    createId: () => `profile-${++nextId}`,
  });
  return {
    directory,
    target: { kind: "ssh" as const, host: "example.invalid", username: "fixture" },
  };
}
function fakeConnection(id = "fixture-source") {
  const closes = new Emitter<void>();
  let disposed = false;
  let disposeCount = 0;
  const connection: SourceServerRpcConnection = {
    serverInfo: {
      protocolVersion: 1,
      serverId: id,
      version: "3.15.1",
      authRequired: true,
      capabilities: { desktopContinuous: true, websocketRpc: true, sourceServer: true },
      compatibility: ZCODE_COMPATIBILITY_MANIFEST,
    },
    services: {} as IServiceAccessor,
    onDidClose: closes.event,
    get isClosed() {
      return disposed;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      disposeCount += 1;
      closes.fire();
    },
  };
  return { connection, count: () => disposeCount };
}
function fakeTransport() {
  let disposeCount = 0;
  const transport = {
    ingressToken: "a".repeat(64),
    backend: {},
    openChannel: async () => {
      throw new Error("Unused fixture channel");
    },
    dispose: async () => {
      disposeCount += 1;
    },
  } as SourceServerTransport;
  return { transport, count: () => disposeCount };
}

test("canceling one shared-profile waiter does not cancel another admitted waiter", async () => {
  const { directory, target } = fixture();
  const profile = await directory.ensureProfile(target);
  const rpc = fakeConnection();
  const io = fakeTransport();
  const start = deferred<void>();
  const gate = deferred<SourceServerTransport>();
  let preparationSignal: AbortSignal | undefined;
  const manager = new SourceServerConnectionManager({
    directory,
    connectTransport: async (_target, options) => {
      preparationSignal = options?.signal;
      start.resolve();
      return gate.promise;
    },
    connectRpc: async () => rpc.connection,
  });
  try {
    const canceled = new AbortController();
    const first = manager.retain(profile, target, canceled.signal);
    const firstRejected = assert.rejects(first);
    const second = manager.retain(profile, target);
    await start.promise;
    canceled.abort();
    await firstRejected;
    assert.equal(preparationSignal?.aborted, false);
    gate.resolve(io.transport);
    const handle = await second;
    assert.equal(handle.sourceServerId, "fixture-source");
    await handle.dispose();
    assert.equal(rpc.count(), 0);
  } finally {
    await manager.dispose();
    directory.dispose();
  }
  assert.equal(rpc.count(), 1);
  assert.equal(io.count(), 1);
});

test("late transport after all waiters cancel is disposed and cannot publish a source", async () => {
  const { directory, target } = fixture();
  const profile = await directory.ensureProfile(target);
  const io = fakeTransport();
  const start = deferred<void>();
  const gate = deferred<SourceServerTransport>();
  let rpcCalls = 0;
  const manager = new SourceServerConnectionManager({
    directory,
    connectTransport: async () => {
      start.resolve();
      return gate.promise;
    },
    connectRpc: async () => {
      rpcCalls += 1;
      return fakeConnection().connection;
    },
  });
  const abort = new AbortController();
  const waiting = manager.retain(profile, target, abort.signal);
  const rejected = assert.rejects(waiting);
  await start.promise;
  abort.abort();
  await rejected;
  gate.resolve(io.transport);
  await manager.dispose();
  assert.equal(rpcCalls, 0);
  assert.equal(io.count(), 1);
  directory.dispose();
});

test("source close during the publication barrier rejects rather than publishing dead services", async () => {
  const { directory, target } = fixture();
  const profile = await directory.ensureProfile(target);
  const io = fakeTransport();
  const rpc = fakeConnection();
  const entered = deferred<void>();
  const finish = deferred<void>();
  const manager = new SourceServerConnectionManager({
    directory,
    connectTransport: async () => io.transport,
    connectRpc: async () => rpc.connection,
    beforePublish: async () => {
      entered.resolve();
      await finish.promise;
    },
  });
  const waiting = manager.retain(profile, target);
  const rejected = assert.rejects(waiting);
  await entered.promise;
  rpc.connection.dispose();
  finish.resolve();
  await rejected;
  assert.equal(
    manager.listStates().some((state) => state.state === "online"),
    false,
  );
  await manager.dispose();
  assert.equal(io.count(), 1);
  directory.dispose();
});

test("shared source handles retain their own profile configuration strategy", async () => {
  const { directory, target } = fixture();
  const first = await directory.ensureProfile(target);
  const rpc = fakeConnection();
  const inspection = {
    getCapabilities: async () => ({ version: 1 as const }),
    inspect: async () => {
      throw new Error("Unused inspection fixture");
    },
  };
  rpc.connection.workspaceInspection = inspection;
  const io = fakeTransport();
  let opened = 0;
  const manager = new SourceServerConnectionManager({
    directory,
    connectTransport: async () => {
      opened += 1;
      return io.transport;
    },
    connectRpc: async () => rpc.connection,
  });
  try {
    const primary = await manager.retain(first, target);
    const route = { ...target, host: "other.example.invalid" };
    const second = await directory.ensureProfile(route);
    const bound = await directory.recordHandshake(second, rpc.connection.serverInfo);
    const mirror = await directory.saveProfile({ ...bound, configurationMode: "mirror-personal" });
    const another = await manager.retain(mirror, route);
    assert.equal(another.profile.profileId, mirror.profileId);
    assert.equal(another.profile.configurationMode, "mirror-personal");
    assert.equal(primary.profile.configurationMode, "target");
    assert.equal(primary.workspaceInspection, inspection);
    assert.equal(another.workspaceInspection, inspection);
    assert.equal("workspaceInspection" in primary.services, false);
    assert.equal(opened, 1);
    await primary.dispose();
    await another.dispose();
  } finally {
    await manager.dispose();
    directory.dispose();
  }
});

test("confirmed identity retires the previous physical generation and accepts only the new profile", async () => {
  const { directory, target } = fixture();
  const initial = await directory.ensureProfile(target);
  const connections = [fakeConnection("source-a"), fakeConnection("source-b")];
  const transports = [fakeTransport(), fakeTransport()];
  let index = 0;
  const manager = new SourceServerConnectionManager({
    directory,
    connectTransport: async () => transports[index]!.transport,
    connectRpc: async () => connections[index++]!.connection,
  });
  try {
    const previous = await manager.retain(initial, target);
    const bound = await directory.assertCurrent(initial);
    const accepted = await manager.retain(bound, target, undefined, "source-b");
    assert.equal(accepted.sourceServerId, "source-b");
    assert.equal(accepted.profile.generation, bound.generation + 1);
    assert.equal(connections[0]!.count(), 1);
    assert.equal(transports[0]!.count(), 1);
    await assert.rejects(manager.retain(bound, target), /stale/);
    await previous.dispose();
    await accepted.dispose();
    assert.equal(connections[1]!.count(), 0);
  } finally {
    await manager.dispose();
    directory.dispose();
  }
});

test("a delayed startup Directory snapshot cannot retire an already committed online generation", async () => {
  let settings = {} as AppSettings;
  let pause = false;
  const requested = deferred<void>();
  const stale = deferred<AppSettings>();
  const directory = new SourceServerDirectory({
    settingService: {
      get: async () => {
        if (pause) {
          pause = false;
          requested.resolve();
          return stale.promise;
        }
        return structuredClone(settings);
      },
      update: async (patch) => {
        settings = { ...settings, ...structuredClone(patch) };
      },
    },
    credentialService: { load: async () => null, save: async () => {}, delete: async () => {} },
    createId: () => "profile-a",
  });
  const target = { kind: "docker" as const, container: "fixture" };
  const initial = await directory.ensureProfile(target);
  const oldSettings = structuredClone(settings);
  pause = true;
  const rpc = fakeConnection();
  const io = fakeTransport();
  const manager = new SourceServerConnectionManager({
    directory,
    connectTransport: async () => io.transport,
    connectRpc: async () => rpc.connection,
  });
  try {
    await requested.promise;
    const saved = await directory.saveProfile({ ...initial, displayName: "New generation" });
    const handle = await manager.retain(saved, target);
    stale.resolve(oldSettings);
    const stillLive = await manager.retain(saved, target);
    assert.equal(rpc.count(), 0);
    assert.equal(manager.listStates()[0]?.state, "online");
    await handle.dispose();
    await stillLive.dispose();
  } finally {
    stale.resolve(oldSettings);
    await manager.dispose();
    directory.dispose();
  }
});

test("explicit disconnect only releases the captured source generation", async () => {
  const { directory, target } = fixture();
  const profile = await directory.ensureProfile(target);
  const connections = [fakeConnection(), fakeConnection()];
  const transports = [fakeTransport(), fakeTransport()];
  let index = 0;
  const manager = new SourceServerConnectionManager({
    directory,
    connectTransport: async () => transports[index]!.transport,
    connectRpc: async () => connections[index++]!.connection,
  });
  try {
    const old = await manager.retain(profile, target);
    await manager.disconnect(old.sourceServerId);
    const current = await manager.retain(await directory.assertCurrent(profile), target);
    connections[0]!.connection.dispose();
    assert.equal(
      manager.listStates().find((state) => state.profileId === profile.profileId)?.state,
      "online",
    );
    assert.equal(connections[1]!.count(), 0);
    await current.dispose();
  } finally {
    await manager.dispose();
    directory.dispose();
  }
});
