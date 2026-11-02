import assert from "node:assert/strict";
import test from "node:test";
import { SourceServerDirectory } from "../../packages/desktop/src/host/sourceServerDirectory.ts";
import { SourceServerConnectionManager } from "../../packages/desktop/src/host/sourceServerConnectionManager.ts";
import { ZCODE_COMPATIBILITY_MANIFEST } from "../../packages/shared/src/index.ts";

test("failed predeployed connection retains Source/Profile/history and recovers without deployment", async () => {
  const profile = {
    profileId: "fixture-profile",
    generation: 1,
    sourceServerId: "fixture-source",
    displayName: "Fixture",
    target: { kind: "docker", container: "fixture" },
    configurationMode: "target",
    createdAt: 1,
  };
  let settings = {
    sourceServerDirectory: {
      schemaVersion: 1,
      generation: 1,
      profiles: [profile],
      servers: [
        {
          sourceServerId: "fixture-source",
          displayName: "Fixture",
          version: "3.17.1",
          preferredProfileId: profile.profileId,
          lastOnlineAt: 1,
        },
      ],
    },
    sourceServerWorkspaceHistory: [
      { sourceServerId: "fixture-source", workspacePath: "/synthetic/history" },
    ],
  };
  const before = structuredClone(settings);
  const directory = new SourceServerDirectory({
    settingService: {
      async get() {
        return settings;
      },
      async update(patch) {
        settings = { ...settings, ...patch };
      },
    },
    credentialService: {
      async load() {
        return null;
      },
      async save() {
        throw new Error("UNEXPECTED_CREDENTIAL_WRITE");
      },
      async delete() {
        throw new Error("UNEXPECTED_CREDENTIAL_WRITE");
      },
    },
    now: () => 2,
  });
  let failed = true;
  let connects = 0;
  const calls = [];
  const manager = new SourceServerConnectionManager({
    directory,
    async connectTransport() {
      connects++;
      if (failed) throw new Error("FIXTURE_TRANSPORT_FAILED");
      return {
        backend: {
          async upload() {
            calls.push("upload");
            throw new Error("UNEXPECTED_DEPLOY");
          },
          async exec() {
            calls.push("exec");
            throw new Error("UNEXPECTED_DEPLOY");
          },
        },
        async dispose() {
          calls.push("dispose");
        },
      };
    },
    async connectRpc() {
      return {
        serverInfo: {
          serverId: "fixture-source",
          version: "3.17.1",
          compatibility: ZCODE_COMPATIBILITY_MANIFEST,
        },
        services: {},
        isClosed: false,
        onDidClose: () => ({ dispose() {} }),
        dispose() {},
      };
    },
  });
  try {
    await assert.rejects(manager.retain(profile, profile.target), /FIXTURE_TRANSPORT_FAILED/);
    assert.deepEqual(settings, before);
    assert.equal(manager.listStates()[0].state, "failed");
    assert.equal(manager.getOnlineSource("fixture-source"), undefined);
    failed = false;
    const handle = await manager.retain(profile, profile.target);
    assert.equal(handle.sourceServerId, "fixture-source");
    assert.equal(manager.listStates()[0].state, "online");
    const after = await directory.snapshot();
    assert.equal(after.profiles[0].profileId, profile.profileId);
    assert.equal(after.profiles[0].generation, profile.generation);
    assert.equal(after.profiles[0].sourceServerId, profile.sourceServerId);
    assert.deepEqual(settings.sourceServerWorkspaceHistory, before.sourceServerWorkspaceHistory);
    assert.equal(connects, 2);
    assert.deepEqual(calls, []);
    await handle.dispose();
  } finally {
    await manager.dispose();
    directory.dispose();
  }
});
