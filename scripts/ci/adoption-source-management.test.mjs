import assert from "node:assert/strict";
import { test } from "node:test";
import { sourceServerManagementSnapshotSchema } from "../../packages/shared/src/source-server/contract.ts";
import { loadComponentCallback } from "./fixtures/component-callback.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const path = "packages/ui/src/hooks/useSourceServerManagement.ts";
function snapshot(value) {
  return {
    directory: { schemaVersion: 1, generation: value, profiles: [], servers: [] },
    states: [],
  };
}
async function fixture() {
  const requests = [];
  const writes = [];
  const service = {
    getCapabilities: async () => ({ version: 1 }),
    getSnapshot: () => {
      const request = deferred();
      requests.push(request);
      return request.promise;
    },
  };
  const generation = { current: 1 };
  const requestSequence = { current: 0 };
  const serviceRef = { current: service };
  const refresh = await loadComponentCallback(path, "refresh", {
    service,
    generation,
    requestSequence,
    serviceRef,
    sourceServerManagementSnapshotSchema,
    setOwned: (value) => writes.push(value),
  });
  return { requests, writes, generation, serviceRef, service, refresh };
}

test("older Source management refreshes cannot replace a newer snapshot", async () => {
  const { requests, writes, refresh } = await fixture();
  const first = refresh();
  const second = refresh();
  await Promise.resolve();
  requests[1].resolve(snapshot(2));
  await second;
  requests[0].resolve(snapshot(1));
  await first;
  assert.equal(writes.length, 1);
  assert.equal(writes[0].state.snapshot.directory.generation, 2);
});

test("older Source management errors cannot hide the latest ready snapshot", async () => {
  const { requests, writes, refresh } = await fixture();
  const first = refresh();
  const second = refresh();
  await Promise.resolve();
  requests[1].resolve(snapshot(2));
  await second;
  requests[0].reject(new Error("Fixture stale request"));
  await first;
  assert.equal(writes.length, 1);
  assert.equal(writes[0].state.status, "ready");
});

test("a replaced Host cannot publish its outstanding Source management snapshot", async () => {
  const { requests, writes, generation, serviceRef, refresh } = await fixture();
  const first = refresh();
  await Promise.resolve();
  generation.current += 1;
  serviceRef.current = undefined;
  requests[0].resolve(snapshot(1));
  await first;
  assert.equal(writes.length, 0);
});

test("unsupported Source management capabilities do not request a snapshot", async () => {
  const { service, requests, writes, refresh } = await fixture();
  service.getCapabilities = async () => ({ version: 2 });
  await refresh();
  assert.equal(requests.length, 0);
  assert.equal(writes[0].state.status, "error");
});
