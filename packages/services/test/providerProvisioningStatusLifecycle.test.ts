import assert from "node:assert/strict";
import test from "node:test";
import { HostMessageTypes, HostResponseTypes } from "@zcode/shared";
import { createHostProviderProvisioningStatus } from "../src/provider-provisioning-status/hostProviderProvisioningStatus.js";

type Posted = Record<string, unknown>;

function makeInstance() {
  const posted: Posted[] = [];
  const lane = createHostProviderProvisioningStatus((message) => {
    posted.push(message as Posted);
  });
  return { lane, posted };
}

function resultFor(requestId: string) {
  return {
    type: HostMessageTypes.ProviderProvisioningLaneResult,
    requestId,
    status: { lane: "none" },
  } as never;
}

test("lane request carries a unique requestId and is answered by handleResult", async () => {
  const { lane, posted } = makeInstance();
  const pending = lane.service.getStatus({ sourceServerId: "src-1" });
  assert.equal(posted.length, 1);
  const first = posted[0];
  assert.equal(first.type, HostResponseTypes.ProviderProvisioningLaneRequest);
  assert.equal(first.action, "read");
  const requestId = String(first.requestId);
  assert.ok(requestId.length > 0);
  assert.equal(lane.handleResult(resultFor(requestId)), true);
  assert.deepEqual(await pending, { lane: "none" });
});

test("unknown requestId is not consumed by this lane", () => {
  const { lane } = makeInstance();
  assert.equal(lane.handleResult(resultFor("provider-provisioning-lane-unknown")), false);
});

test("dispose rejects in-flight requests and blocks later requests", async () => {
  const { lane } = makeInstance();
  const pending = lane.service.retry({ sourceServerId: "src-1" });
  lane.dispose();
  await assert.rejects(pending, (error: unknown) => {
    return (error as { code?: string }).code === "disposed";
  });
  await assert.rejects(lane.service.getStatus({ sourceServerId: "src-1" }), {
    code: "disposed",
  } as never);
});

test("a late result from the previous instance cannot resolve the replaced instance", async () => {
  // 回归：requestId 只用 Date.now()+sequence 时，同毫秒换代可能碰撞，
  // 旧实例的迟到回包会命中新实例的 pending，把错误的 lane 状态当成答案。
  const oldInstance = makeInstance();
  const stalePending = oldInstance.lane.service.getStatus({ sourceServerId: "src-1" });
  const staleRequestId = String(oldInstance.posted[0].requestId);
  oldInstance.lane.dispose();
  await assert.rejects(stalePending, { code: "disposed" } as never);

  const next = makeInstance();
  const freshPending = next.lane.service.getStatus({ sourceServerId: "src-1", waitForIdle: true });
  const freshRequestId = String(next.posted[0].requestId);
  assert.notEqual(freshRequestId, staleRequestId);

  // 旧 requestId 到达新实例：必须忽略，不能让新请求提前 resolve。
  assert.equal(next.lane.handleResult(resultFor(staleRequestId)), false);
  let settled = false;
  void freshPending.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  assert.equal(next.lane.handleResult(resultFor(freshRequestId)), true);
  assert.deepEqual(await freshPending, { lane: "none" });
});
