import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { createWindowRemoteConnectionRegistry } from "../../../packages/desktop/src/host/windowRemoteConnectionRegistry.ts";

const failure = new Error("fixture workspace unavailable");
const path = "/fixture/unavailable";

function fixture(target, { fail = true, ttl = 1000 } = {}) {
  let ids = 0;
  let disposals = 0;
  const handle = {
    services: { fixture: true },
    sourceServerId: "fixture-source",
    async inspectWorkspace(context) {
      if (fail && context.workspacePath === path) throw failure;
    },
    async dispose() {
      disposals++;
    },
  };
  const registry = createWindowRemoteConnectionRegistry({
    connect: async () => handle,
    createId: () => `fixture-session-${++ids}`,
    wslIdleTtlMs: ttl,
  });
  return {
    registry,
    handle,
    disposals: () => disposals,
    connect(workspacePath = path) {
      return registry.connect({
        requestId: `fixture-request-${ids + 1}`,
        target,
        remoteAssets: {},
        workspacePath,
        workspaceIdentity: `fixture-route:${workspacePath}`,
      });
    },
  };
}

test("failed Server workspace releases its dedicated handle before reporting failure", async () => {
  const context = fixture({ kind: "server", url: "http://fixture.invalid" });
  try {
    await assert.rejects(context.connect(), (error) => error === failure);
    assert.equal(context.disposals(), 1);
    assert.deepEqual(context.registry.getStats(), { connectionCount: 0, logicalSessionCount: 0 });
  } finally {
    await context.registry.dispose();
  }
  assert.equal(context.disposals(), 1);
});

test("failed WSL workspace starts the existing idle TTL", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const context = fixture({ kind: "wsl", distro: "fixture" });
  try {
    await assert.rejects(context.connect(), (error) => error === failure);
    assert.equal(context.disposals(), 0);
    t.mock.timers.tick(1000);
    await nextTurn();
    assert.equal(context.disposals(), 1);
    assert.deepEqual(context.registry.getStats(), { connectionCount: 0, logicalSessionCount: 0 });
  } finally {
    await context.registry.dispose();
  }
});

test("failed WSL workspace does not retire a sibling owner after the idle TTL", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const context = fixture({ kind: "wsl", distro: "fixture" });
  try {
    const sibling = await context.connect("/fixture/available");
    await assert.rejects(context.connect(), (error) => error === failure);
    t.mock.timers.tick(1000);
    await nextTurn();
    assert.equal(context.disposals(), 0);
    assert.deepEqual(context.registry.getStats(), { connectionCount: 1, logicalSessionCount: 1 });
    assert.equal(
      context.registry.resolveScopedServices({ kind: "remote", ...sibling }),
      context.handle.services,
    );
  } finally {
    await context.registry.dispose();
  }
});

test("failed SSH workspace keeps the ready window cache for later attachment", async () => {
  const context = fixture({ kind: "ssh", host: "fixture.invalid", username: "fixture" });
  try {
    await assert.rejects(context.connect(), (error) => error === failure);
    assert.equal(context.disposals(), 0);
    const sibling = await context.connect("/fixture/available");
    assert.equal(
      context.registry.resolveScopedServices({ kind: "remote", ...sibling }),
      context.handle.services,
    );
    assert.deepEqual(context.registry.getStats(), { connectionCount: 1, logicalSessionCount: 1 });
  } finally {
    await context.registry.dispose();
  }
  assert.equal(context.disposals(), 1);
});

test("failed Docker workspace still releases its dedicated handle once", async () => {
  const context = fixture({ kind: "docker", container: "fixture" });
  try {
    await assert.rejects(context.connect(), (error) => error === failure);
    assert.equal(context.disposals(), 1);
    assert.deepEqual(context.registry.getStats(), { connectionCount: 0, logicalSessionCount: 0 });
  } finally {
    await context.registry.dispose();
  }
  assert.equal(context.disposals(), 1);
});
