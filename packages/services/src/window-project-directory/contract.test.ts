import assert from "node:assert/strict";
import { Emitter } from "@zcode/rpc";
import { test } from "node:test";
import { createWindowProjectDirectoryRuntime } from "./index.js";

function entry(key: string, remoteSessionId?: string) {
  return {
    workspaceKey: key,
    workspacePath: "/workspace",
    ...(remoteSessionId ? { workspaceIdentity: key, remoteSessionId } : {}),
    kind: remoteSessionId ? ("remote" as const) : ("local" as const),
  };
}

test("window directory exposes one atomic group without replacing scoped services", async () => {
  const owner = createWindowProjectDirectoryRuntime();
  owner.accept({
    version: 1,
    generation: 1,
    workspaces: [entry("/workspace"), entry("remote:server:fixture:/workspace", "remote-1")],
  });
  const snapshot = await owner.services.projectService.readDirectory();
  assert.equal(snapshot.workspaces.length, 2);
  assert.deepEqual((await owner.services.remoteProjectService.readDirectory()).entries, [
    snapshot.workspaces[1],
  ]);
  assert.deepEqual(await owner.services.changesService.getCapabilities(), { version: 1 });
  owner.dispose();
});

test("old window projection generations and duplicate deliveries do not publish again", async () => {
  const owner = createWindowProjectDirectoryRuntime();
  let changes = 0;
  owner.services.changesService.onDidChange(() => {
    changes += 1;
  });
  owner.accept({ version: 1, generation: 2, workspaces: [entry("/workspace")] });
  owner.accept({ version: 1, generation: 1, workspaces: [] });
  owner.accept({ version: 1, generation: 2, workspaces: [] });
  assert.equal(changes, 1);
  assert.equal((await owner.services.projectService.readDirectory()).workspaces.length, 1);
  owner.dispose();
});

test("returned directory objects cannot mutate the projection owner", async () => {
  const owner = createWindowProjectDirectoryRuntime();
  owner.accept({ version: 1, generation: 1, workspaces: [entry("/workspace")] });
  const snapshot = await owner.services.projectService.readDirectory();
  snapshot.workspaces[0]!.label = "Changed";
  snapshot.workspaces.splice(0);
  assert.equal(
    (await owner.services.projectService.readDirectory()).workspaces[0]?.label,
    undefined,
  );
  owner.dispose();
});

test("window directory refuses malformed identity and has no settings or secret fields", async () => {
  const owner = createWindowProjectDirectoryRuntime();
  assert.throws(() =>
    owner.accept({
      version: 1,
      generation: 1,
      workspaces: [{ ...entry("/workspace"), workspaceKey: "other" }],
    }),
  );
  assert.throws(() =>
    owner.accept({
      version: 1,
      generation: 1,
      workspaces: [{ ...entry("/workspace"), password: "fixture-secret" }],
    } as never),
  );
  owner.dispose();
});

test("connection facts come from the registry and its event subscription is released", async () => {
  const connections = new Emitter<void>();
  let state = "connected" as "connected" | "disconnected";
  const owner = createWindowProjectDirectoryRuntime({
    resolveConnectionState: () => state,
    onDidConnectionChange: connections.event,
  });
  const remote = entry("remote:server:fixture:/workspace", "remote-1");
  owner.accept({ version: 1, generation: 1, workspaces: [remote] });
  let changes = 0;
  owner.services.changesService.onDidChange(() => {
    changes += 1;
  });
  state = "disconnected";
  connections.fire();
  assert.equal(
    (await owner.services.projectService.readDirectory()).workspaces[0]?.connectionState,
    "disconnected",
  );
  assert.equal(
    (await owner.services.remoteProjectService.readDirectory()).entries[0]?.connectionState,
    "disconnected",
  );
  assert.equal(changes, 1);
  owner.dispose();
  connections.fire();
  assert.equal(changes, 1);
});

test("disposing the window directory releases event listeners and rejects old reads", async () => {
  const owner = createWindowProjectDirectoryRuntime();
  let changes = 0;
  owner.services.changesService.onDidChange(() => {
    changes += 1;
  });
  owner.dispose();
  owner.accept({ version: 1, generation: 1, workspaces: [] });
  assert.equal(changes, 0);
  await assert.rejects(owner.services.projectService.readDirectory());
  await assert.rejects(owner.services.remoteProjectService.readDirectory());
  await assert.rejects(owner.services.changesService.getCapabilities());
});
