import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { runHandleRetryConnection } from "../../packages/ui/src/remote-connection-flow/flowRecovery.ts";

async function fixture() {
  let resolve, reject;
  const pending = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  const events = [];
  const manager = {
    confirmIdentityChange: async () => {
      events.push("confirm");
      return pending;
    },
  };
  const epoch = { current: 1 },
    managementRef = { current: manager },
    admission = { current: null };
  const target = { kind: "ssh", host: "fixture.invalid", username: "fixture" };
  const context = {
    errorCode: "source-server-identity-change-pending",
    sourceManagementSnapshot: {
      directory: { profiles: [{ profileId: "fixture", generation: 1, target }], servers: [] },
      states: [
        {
          profileId: "fixture",
          generation: 1,
          state: "identity-change-pending",
          pendingSourceServerId: "fixture-source",
        },
      ],
    },
    pendingRemoteTarget: target,
    preferredProfileId: "fixture",
    sourceManagement: manager,
    sourceManagementRef: managementRef,
    identityLoading: false,
    entryEpochRef: epoch,
    identityAdmissionRef: admission,
    getRemoteIdentityConfirmation: () => ({
      profileId: "fixture",
      generation: 1,
      expectedSourceServerId: "fixture-source",
    }),
    setIdentityLoading: (value) => events.push(["busy", value]),
    applySourceManagementSnapshot: () => events.push("snapshot"),
    handleStartPendingRemoteConnection: () => events.push("connect"),
    setError: () => events.push("error"),
    getErrorMessage: () => "fixture",
  };
  const callback = () => runHandleRetryConnection(context);
  return { callback, events, epoch, managementRef, resolve, reject };
}
test("identity confirmation admits a double click once before React commits", async () => {
  const f = await fixture();
  f.callback();
  f.callback();
  assert.equal(f.events.filter((x) => x === "confirm").length, 1);
  f.resolve({});
  await setImmediate();
  assert.equal(f.events.filter((x) => x === "connect").length, 1);
});
test("manager replacement rejects stale failure and completion UI publications", async () => {
  const f = await fixture();
  f.callback();
  f.managementRef.current = {};
  f.reject(Error("fixture"));
  await setImmediate();
  assert.equal(f.events.includes("error"), false);
  assert.equal(f.events.includes("connect"), false);
  assert.equal(
    f.events.filter((x) => Array.isArray(x) && x[0] === "busy" && x[1] === false).length,
    0,
  );
});
test("cancelled confirmation cannot restart a connection or clear new busy state", async () => {
  const f = await fixture();
  f.callback();
  f.epoch.current++;
  f.resolve({});
  await setImmediate();
  assert.equal(f.events.includes("snapshot"), false);
  assert.equal(f.events.includes("connect"), false);
  assert.equal(f.events.filter((x) => Array.isArray(x) && x[1] === false).length, 0);
});
