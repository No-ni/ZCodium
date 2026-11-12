import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createBusinessFixture,
  loadBusinessRootSource,
  trackKeepWarmTimers,
} from "./fixtures/native-mobile-business-root-lifecycle.mjs";

const source = await loadBusinessRootSource();

function assertConnected(state) {
  assert.equal(state.failureCode, null, "Home to Chat must keep its original data layer usable");
  assert.ok(state.bundle.layer instanceof source.SessionDataLayer);
  assert.ok(state.lease.store instanceof source.ConversationProjectionStore);
  assert.equal(state.lease.store.getState().status, "live", "real subscribe ACK must succeed");
  assert.equal(state.lease.store.getState().lastError, null);
  assert.equal(state.transports[0].calls.activated.length, 1);
  assert.deepEqual(state.unhandled, []);
}

test("actual mobile main render permits Home to Chat acquire on the committed Provider", async (t) => {
  const fixture = await createBusinessFixture(source);
  try {
    await fixture.mount();
    assert.ok(fixture.document.querySelector("[data-page='home']"));
    await fixture.navigate();
    t.diagnostic(
      JSON.stringify({
        stage: "home-to-chat",
        failureCode: fixture.state.failureCode,
        transportCount: fixture.state.transports.length,
        hasLease: fixture.state.lease !== null,
      }),
    );
    // 原入口的模拟 cleanup 释放 memo bundle；业务成功期望必须直接暴露 disposed 失败。
    assertConnected(fixture.state);
    assert.ok(fixture.document.querySelector("[data-page='chat']"));
  } finally {
    await fixture.close();
  }
});

test("non-Strict actual Provider reuses the same live store across Home and Chat", async () => {
  const fixture = await createBusinessFixture(source);
  try {
    await fixture.mount(false);
    await fixture.navigate();
    assertConnected(fixture.state);
    const first = fixture.state.lease;
    assert.equal(first.openKind, "cold");
    await fixture.navigate();
    assert.equal(fixture.state.bundle.layer.size, 1, "Home retains the real keep-warm store");
    assert.equal(first.store.getState().status, "live");
    await fixture.navigate();
    assertConnected(fixture.state);
    assert.equal(fixture.state.lease.openKind, "keep_warm");
    assert.equal(fixture.state.lease.store, first.store);
    assert.equal(fixture.state.transports.length, 1);
    assert.equal(fixture.state.transports[0].calls.subscriptions.length, 1);
  } finally {
    await fixture.close();
  }
});

test("true unmount disposes the actual layer, closes its store and clears keep-warm resources", async () => {
  const fixture = await createBusinessFixture(source);
  const timers = trackKeepWarmTimers(source.SESSION_DATA_LAYER_KEEP_WARM_MS);
  try {
    await fixture.mount(false);
    await fixture.navigate();
    assertConnected(fixture.state);
    const { layer } = fixture.state.bundle;
    const { store } = fixture.state.lease;
    const transport = fixture.state.transports[0];
    assert.deepEqual(
      Object.values(transport.listeners).map((set) => set.size),
      [1, 1, 1],
    );
    await fixture.navigate();
    assert.equal(timers.pending.size, 1, "real release schedules exactly one keep-warm timer");
    await fixture.unmount();
    assert.equal(timers.pending.size, 0, "real Provider cleanup cancels the scheduled timer");
    assert.equal(layer.size, 0);
    assert.equal(store.getState().status, "closed");
    assert.deepEqual(
      Object.values(transport.listeners).map((set) => set.size),
      [0, 0, 0],
    );
    assert.deepEqual(transport.calls.unsubscribed, transport.calls.activated);
    assert.throws(() => layer.acquire("source-session"), /SessionDataLayer 已释放，不能再 acquire/);
    layer.dispose();
    assert.equal(transport.calls.unsubscribed.length, 1, "dispose remains idempotent");
    assert.deepEqual(fixture.state.unhandled, []);
  } finally {
    try {
      await fixture.close();
    } finally {
      timers.restore();
    }
  }
});
