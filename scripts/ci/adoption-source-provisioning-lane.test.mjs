import assert from "node:assert/strict";
import { test } from "node:test";
import { tsImport } from "tsx/esm/api";

const { ProviderProvisioningEnvironmentCoordinator } = await tsImport(
  "../../packages/desktop/src/main/providerProvisioningEnvironmentCoordinator.ts",
  import.meta.url,
);
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("a successful retired executor cannot complete a new registration generation", async () => {
  const coordinator = new ProviderProvisioningEnvironmentCoordinator();
  const old = deferred();
  let oldCalls = 0;
  let newCalls = 0;
  const first = coordinator.register("source-server:a", "attachment", async () => {
    oldCalls++;
    await old.promise;
  });
  first.dispose();
  const next = coordinator.register("source-server:a", "attachment", async () => {
    newCalls++;
  });
  old.resolve();
  await Promise.all([first.initialSync, next.initialSync]);
  assert.equal(oldCalls, 1);
  assert.equal(newCalls, 1);
  next.dispose();
});

test("a same-id replacement retries initial sync after the retired executor rejects", async () => {
  const coordinator = new ProviderProvisioningEnvironmentCoordinator();
  const old = deferred();
  let newCalls = 0;
  const first = coordinator.register("source-server:a", "attachment", () => old.promise);
  const initial = first.initialSync.catch(() => undefined);
  first.dispose();
  const next = coordinator.register("source-server:a", "attachment", async () => {
    newCalls++;
  });
  old.reject(new Error("retired fixture"));
  await next.initialSync;
  await initial;
  assert.equal(newCalls, 1);
  next.dispose();
});

test("an old disposer cannot erase an already installed same-id registration", async () => {
  const coordinator = new ProviderProvisioningEnvironmentCoordinator();
  const first = coordinator.register("source-server:a", "attachment", async () => {});
  await first.initialSync;
  let calls = 0;
  const next = coordinator.register("source-server:a", "attachment", async () => {
    calls++;
  });
  await next.initialSync;
  first.dispose();
  await coordinator.requestAll("personal-config");
  assert.equal(calls, 1);
  next.dispose();
});

test("a failed initial sync remains pending for a later explicit registration", async () => {
  const coordinator = new ProviderProvisioningEnvironmentCoordinator();
  const first = coordinator.register("source-server:a", "one", async () => {
    throw new Error("fixture initial failure");
  });
  await assert.rejects(first.initialSync, /fixture initial failure/);
  let calls = 0;
  const next = coordinator.register("source-server:a", "two", async () => {
    calls++;
  });
  first.dispose();
  await next.initialSync;
  assert.equal(calls, 1);
  next.dispose();
});

test("a replacement installed during apply cannot borrow the retired executor's success", async () => {
  const coordinator = new ProviderProvisioningEnvironmentCoordinator();
  const old = deferred();
  const first = coordinator.register("source-server:a", "attachment", () => old.promise);
  let calls = 0;
  const next = coordinator.register("source-server:a", "attachment", async () => {
    calls++;
  });
  first.dispose();
  old.resolve();
  await Promise.all([first.initialSync, next.initialSync]);
  assert.equal(calls, 1);
  next.dispose();
});

test("a synchronous executor trigger stays inside the already registered drain", async () => {
  const coordinator = new ProviderProvisioningEnvironmentCoordinator();
  const triggers = [];
  let queued;
  let active = 0;
  let maximumActive = 0;
  const registration = coordinator.register("source-server:a", "attachment", async (trigger) => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    triggers.push(trigger);
    if (trigger === "environment-online") queued = coordinator.requestAll("personal-config");
    await Promise.resolve();
    active--;
  });
  await registration.initialSync;
  await queued;
  assert.deepEqual(triggers, ["environment-online", "personal-config"]);
  assert.equal(maximumActive, 1);
  registration.dispose();
});

test("stable Source identity serializes updates and keeps independent Sources separate", async () => {
  const coordinator = new ProviderProvisioningEnvironmentCoordinator();
  const calls = [];
  const first = coordinator.register("source-server:a", "one", async (trigger) => {
    calls.push(["a", trigger]);
  });
  const next = coordinator.register("source-server:a", "two", async (trigger) => {
    calls.push(["a2", trigger]);
  });
  const other = coordinator.register("source-server:b", "one", async (trigger) => {
    calls.push(["b", trigger]);
  });
  await Promise.all([first.initialSync, next.initialSync, other.initialSync]);
  assert.deepEqual(calls.sort(), [
    ["a", "environment-online"],
    ["b", "environment-online"],
  ]);
  calls.length = 0;
  await coordinator.requestAll("configured-default");
  assert.deepEqual(calls.sort(), [
    ["a", "configured-default"],
    ["b", "configured-default"],
  ]);
  first.dispose();
  next.dispose();
  other.dispose();
});
