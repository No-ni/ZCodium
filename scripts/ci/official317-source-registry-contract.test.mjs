import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
// UI 包内 @/* 只由自身 tsconfig 定义，根工程 loader 无法解析这些公开入口的内部依赖。
const sourceOptions = {
  parentURL: import.meta.url,
  tsconfig: fileURLToPath(new URL("../../packages/ui/tsconfig.json", import.meta.url)),
};
const { getSourceServerDisplayNameRegistry } = await tsImport(
  "../../packages/ui/src/store/sourceServerDisplayNameRegistry.ts",
  sourceOptions,
);
const { getSourceServerStatusRegistry } = await tsImport(
  "../../packages/ui/src/store/sourceServerStatusRegistry.ts",
  sourceOptions,
);
const { buildRemoteWorkspaceProjection } = await tsImport(
  "../../packages/ui/src/remote/remoteWorkspaceProjection.ts",
  sourceOptions,
);
const flush = async () => {
  for (let n = 0; n < 5; n++) await new Promise((resolve) => setImmediate(resolve));
};
const snapshot = (name) => ({
  directory: {
    schemaVersion: 1,
    generation: 1,
    profiles: [
      {
        profileId: "profile-a",
        generation: 1,
        sourceServerId: "source-a",
        target: { kind: "docker", container: "fixture" },
      },
    ],
    servers: [{ sourceServerId: "source-a", displayName: name, version: "3.17.1" }],
  },
  states: [{ profileId: "profile-a", generation: 1, sourceServerId: "source-a", state: "online" }],
});

test("both registries use the canonical change event and serially refresh directory/states", async () => {
  let value = snapshot("before");
  const callbacks = [];
  let active = 0,
    peak = 0;
  const service = {
    onDidChange(listener) {
      callbacks.push(listener);
      return { dispose() {} };
    },
    async getSnapshot() {
      active++;
      peak = Math.max(peak, active);
      await flush();
      active--;
      return value;
    },
  };
  const names = getSourceServerDisplayNameRegistry(service);
  await flush();
  const statuses = getSourceServerStatusRegistry(service);
  await flush();
  assert.equal(names.getSnapshot().get("source-a"), "before");
  assert.equal(statuses.getSnapshot().get("source-a"), "online");
  peak = 0;
  value = snapshot("after");
  callbacks[0]();
  callbacks[0]();
  callbacks[0]();
  await flush();
  await flush();
  assert.equal(peak, 1);
  assert.equal(names.getSnapshot().get("source-a"), "after");
});

test("remote projection takes project history explicitly rather than inventing management fields", () => {
  const history = [
    {
      workspacePath: "/fixture-project",
      sourceServerId: "source-a",
      workspaceIdentity: "fixture-identity",
    },
  ];
  const projected = buildRemoteWorkspaceProjection({
    managementSnapshot: snapshot("source"),
    workspaceHistory: history,
    tabs: [],
  });
  assert.deepEqual(projected.projectHistory, history);
  assert.deepEqual(projected.devices[0].knownProjects, history);
  assert.equal(projected.devices[0].profiles.length, 1);
});
