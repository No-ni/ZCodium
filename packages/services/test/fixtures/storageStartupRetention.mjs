import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { ZCodeStorageStartupGate } from "../../src/zcode-agent/zcodeStorageStartupGate.ts";

const gate = new ZCodeStorageStartupGate(true);
const state = {
  schemaVersion: 1,
  attemptId: "synthetic-attempt",
  databaseId: "synthetic-database",
  databaseKind: "session",
  sequence: 1,
  phase: "migrating",
  elapsedMs: 0,
};

// 每个取消原因只以 WeakRef 留在夹具中；不得用测试自己的数组持有对象。
async function cancelBatch() {
  const refs = [];
  for (let index = 0; index < 128; index += 1) {
    const controller = new AbortController();
    const reason = new Error(`synthetic cancellation ${index}`);
    refs.push(new WeakRef(reason));
    const outcome = gate.wait(controller.signal).catch(() => {});
    controller.abort(reason);
    await outcome;
  }
  return refs;
}

async function countRetained(refs) {
  // WeakRef 当前 job 的保活语义要求先切换事件循环；只在本轮子进程启用 GC。
  for (let index = 0; index < 4; index += 1) {
    await setImmediate();
    globalThis.gc();
  }
  return refs.filter((ref) => ref.deref() !== undefined).length;
}

try {
  assert.equal(gate.accept(state), true);
  const refs = await cancelBatch();
  const retainedWhileWaiting = await countRetained(refs);
  assert.equal(gate.isWaiting, true);
  assert.equal(gate.snapshot.phase, "migrating");
  assert.equal(gate.accept({ ...state, sequence: 2, phase: "ready" }), true);
  const retainedAfterReady = await countRetained(refs);
  process.stdout.write(
    `${JSON.stringify({ cancelled: refs.length, retainedWhileWaiting, retainedAfterReady })}\n`,
  );
  assert.equal(retainedAfterReady, 0);
  assert.equal(retainedWhileWaiting, 0, "cancelled waiters must not retain reasons until ready");
} finally {
  gate.dispose();
}
