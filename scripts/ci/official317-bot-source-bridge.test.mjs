import assert from "node:assert/strict";
import test from "node:test";
import { createBotProjectBridge } from "../../packages/desktop/src/host/botProjectBridge.ts";
import {
  buildRemoteWorkspaceIdentity,
  buildServerRemoteWorkspaceIdentity,
} from "../../packages/shared/src/index.ts";
import {
  ServiceCollection,
  IZCodeTaskService,
  IZCodeAgentService,
  IModelSelectionService,
} from "../../packages/services/src/index.ts";

const path = "/synthetic/bot";
const serverId = "synthetic-source";
const stable = buildServerRemoteWorkspaceIdentity({ serverId, workspacePath: path });
const target = { kind: "ssh", host: "synthetic.invalid", username: "fixture" };
const legacy = buildRemoteWorkspaceIdentity(path, target);
function fixture() {
  const calls = [];
  const task = {
    async sendPrompt(input) {
      calls.push(input);
    },
  };
  let source;
  let profiles = [{ profileId: "p", generation: 1, sourceServerId: serverId, target }];
  let inspect = async () => {};
  const services = new ServiceCollection()
    .register(IZCodeTaskService, task)
    .register(IZCodeAgentService, { syncAppRuntimePreferences: async () => {} })
    .register(IModelSelectionService, { getView: async () => ({}) });
  source = {
    owner: {},
    services: {
      zcodeTaskService: task,
      zcodeAgentService: services.get(IZCodeAgentService),
      modelSelectionService: services.get(IModelSelectionService),
    },
    inspectWorkspace: async (value) => inspect(value),
  };
  let routes = 0;
  const bridge = createBotProjectBridge({
    resolveSource: (id) => (id === serverId ? source : undefined),
    readDirectory: async () => ({
      profiles,
      servers: profiles.map((profile) => ({ sourceServerId: profile.sourceServerId })),
    }),
    routeTaskService: (base) => {
      routes++;
      return base;
    },
  });
  return {
    bridge,
    calls,
    get routes() {
      return routes;
    },
    setSource: (value) => {
      source = value;
    },
    changeOwner: () => {
      source = { ...source, owner: {} };
    },
    setProfiles: (value) => {
      profiles = value;
    },
    setInspection: (value) => {
      inspect = value;
    },
  };
}

test("legacy and stable scope normalize to one current Source and preserve task routing", async () => {
  const f = fixture();
  for (const identity of [legacy, stable]) {
    const scope = await f.bridge.resolveWorkspace({
      workspacePath: path,
      workspaceIdentity: identity,
    });
    assert.deepEqual(scope, { workspacePath: path, workspaceIdentity: stable });
    const connection = f.bridge.resolveConnection("remote:server:synthetic-source");
    await connection.bindWorkspace(scope);
    await connection.taskService.sendPrompt({ ...scope, taskId: "task", content: "fixture" });
  }
  assert.equal(f.calls.length, 2);
  assert.equal(f.routes, 2);
});

test("offline, unknown and ambiguous aliases cannot fall back to another Source", async () => {
  const f = fixture();
  assert.equal(
    await f.bridge.resolveWorkspace({
      workspacePath: path,
      workspaceIdentity: buildRemoteWorkspaceIdentity(path, { ...target, host: "other.invalid" }),
    }),
    null,
  );
  f.setProfiles([
    { sourceServerId: serverId, target },
    { sourceServerId: "other-source", target },
  ]);
  assert.equal(
    await f.bridge.resolveWorkspace({ workspacePath: path, workspaceIdentity: legacy }),
    null,
  );
  f.setSource(undefined);
  assert.equal(f.bridge.resolveConnection("remote:server:synthetic-source"), undefined);
  assert.equal(
    await f.bridge.resolveWorkspace({ workspacePath: path, workspaceIdentity: stable }),
    null,
  );
  assert.equal(f.calls.length, 0);
});

test("owner replacement during inspection rejects both alias and command admission", async () => {
  const f = fixture();
  f.setInspection(async () => f.changeOwner());
  await assert.rejects(
    f.bridge.resolveWorkspace({ workspacePath: path, workspaceIdentity: legacy }),
    /retired/,
  );
  const connection = f.bridge.resolveConnection("remote:server:synthetic-source");
  await assert.rejects(
    connection.bindWorkspace({ workspacePath: path, workspaceIdentity: stable }),
    /retired/,
  );
});

test("identity/path mismatch and inspection failure stop remote commands", async () => {
  const f = fixture();
  assert.equal(
    await f.bridge.resolveWorkspace({ workspacePath: "/other", workspaceIdentity: stable }),
    null,
  );
  const connection = f.bridge.resolveConnection("remote:server:synthetic-source");
  await assert.rejects(
    connection.bindWorkspace({ workspacePath: "/other", workspaceIdentity: stable }),
    /mismatch/,
  );
  f.setInspection(async () => {
    throw new Error("history-present");
  });
  await assert.rejects(
    connection.bindWorkspace({ workspacePath: path, workspaceIdentity: stable }),
    /history-present/,
  );
  assert.equal(f.calls.length, 0);
});
