import assert from "node:assert/strict";
import { test } from "node:test";
import { tsImport } from "tsx/esm/api";
import { loadComponentCallback } from "./fixtures/component-callback.mjs";

const { createWindowRemoteConnectionRegistry } = await tsImport(
  "../../packages/desktop/src/host/windowRemoteConnectionRegistry.ts",
  import.meta.url,
);
const params = {
  requestId: "fixture-connect",
  target: { kind: "docker", container: "fixture" },
  remoteAssets: {},
  workspacePath: "/fixture",
};
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function registry(handle) {
  return createWindowRemoteConnectionRegistry({
    connect: async () => ({ ...handle, inspectWorkspace: async () => undefined }),
    createId: () => "fixture-session",
  });
}
function scope(descriptor) {
  return {
    kind: "remote",
    remoteSessionId: descriptor.remoteSessionId,
    workspacePath: descriptor.workspacePath,
    workspaceIdentity: descriptor.workspaceIdentity,
  };
}

test("Source target mode cannot authorize provisioning even with a valid Environment", async () => {
  const owner = registry({
    sourceServerId: "fixture-source",
    configurationMode: "target",
    services: {},
    dispose() {},
  });
  const descriptor = await owner.connect(params);
  await assert.rejects(owner.assertProviderProvisioningAllowed(scope(descriptor)), /authoriz|授权/);
  await owner.dispose();
});
test("Source mirror requires a current private Profile authorization", async () => {
  let current = true;
  const owner = registry({
    sourceServerId: "fixture-source",
    configurationMode: "mirror-personal",
    services: {},
    dispose() {},
    async assertProviderProvisioningAllowed() {
      if (!current) throw new Error("Profile authorization retired");
    },
  });
  const descriptor = await owner.connect(params);
  await owner.assertProviderProvisioningAllowed(scope(descriptor));
  current = false;
  await assert.rejects(owner.assertProviderProvisioningAllowed(scope(descriptor)), /retired/);
  await owner.dispose();
});
test("a logical session retired while Profile authorization awaits cannot apply", async () => {
  const barrier = deferred();
  const owner = registry({
    sourceServerId: "fixture-source",
    configurationMode: "mirror-personal",
    services: {},
    dispose() {},
    assertProviderProvisioningAllowed: () => barrier.promise,
  });
  const descriptor = await owner.connect(params);
  const pending = owner.assertProviderProvisioningAllowed(scope(descriptor));
  await owner.disposeSession(descriptor.remoteSessionId);
  barrier.resolve();
  await assert.rejects(pending);
  await owner.dispose();
});
test("missing private Source authorization fails closed and never infers another Profile", async () => {
  const owner = registry({
    sourceServerId: "fixture-source",
    configurationMode: "mirror-personal",
    services: {},
    dispose() {},
  });
  const descriptor = await owner.connect(params);
  await assert.rejects(owner.assertProviderProvisioningAllowed(scope(descriptor)), /authoriz|授权/);
  await owner.dispose();
});
test("legacy remote provisioning preserves its existing admission", async () => {
  const owner = registry({ services: {}, dispose() {} });
  const descriptor = await owner.connect({ ...params, workspaceIdentity: "legacy" });
  await owner.assertProviderProvisioningAllowed(scope(descriptor));
  await owner.dispose();
});
test("reading personal config cannot cross a revoked Source apply boundary", async () => {
  const barrier = deferred();
  let allowed = true;
  let applies = 0;
  const envelope = { schemaVersion: 2, syncId: "fixture", personalConfig: {} };
  const execute = await loadComponentCallback(
    "packages/desktop/src/host/remoteProviderProvisioningService.ts",
    "syncLocalToRemote",
    {
      options: {
        source: { read: () => barrier.promise },
        target: {
          async apply() {
            applies++;
            return { status: "applied" };
          },
        },
      },
      randomUUID: () => "fixture",
      unsupportedResult: () => assert.fail("capability unexpectedly unavailable"),
    },
  );
  const pending = execute(async () => {
    if (!allowed) throw new Error("Fixture authorization retired");
  });
  await Promise.resolve();
  allowed = false;
  barrier.resolve(envelope);
  const result = await pending;
  assert.equal(result.status, "failed");
  assert.equal(applies, 0);
});
test("authorized personal config uses the existing single apply path", async () => {
  let checks = 0;
  const calls = [];
  const envelope = { schemaVersion: 2, syncId: "fixture", personalConfig: {} };
  const execute = await loadComponentCallback(
    "packages/desktop/src/host/remoteProviderProvisioningService.ts",
    "syncLocalToRemote",
    {
      options: {
        source: {
          async read() {
            calls.push("read");
            return envelope;
          },
        },
        target: {
          async apply(value) {
            assert.equal(value, envelope);
            calls.push("apply");
            return { status: "applied" };
          },
        },
      },
      randomUUID: () => "fixture",
      unsupportedResult: () => assert.fail("capability unexpectedly unavailable"),
    },
  );
  const result = await execute(async () => {
    checks++;
    calls.push("authorize");
  });
  assert.equal(result.status, "applied");
  assert.equal(checks, 2);
  assert.deepEqual(calls, ["authorize", "read", "authorize", "apply"]);
});
