import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import workerThreads from "node:worker_threads";
import { createStorageScanWorkerRunner } from "./storageScanWorkerClient.js";

class FakeWorker extends EventEmitter {
  static instances: FakeWorker[] = [];
  terminateCalls = 0;
  posted: unknown[] = [];
  constructor(..._args: unknown[]) {
    super();
    FakeWorker.instances.push(this);
  }
  postMessage(message: unknown) {
    this.posted.push(message);
  }
  terminate() {
    this.terminateCalls++;
    return Promise.resolve(0);
  }
  unref() {}
}

function fixture(t: TestContext, aborted = false) {
  FakeWorker.instances = [];
  // node:test 的构造器 mock 保留原 newTarget；显式返回假实例，避免使用真实 Worker 原型。
  t.mock.method(workerThreads, "Worker", function () {
    return new FakeWorker();
  } as unknown as typeof workerThreads.Worker);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const controller = new AbortController();
  if (aborted) controller.abort();
  const progress: unknown[] = [];
  const promise = createStorageScanWorkerRunner().run({
    roots: [],
    signal: controller.signal,
    onProgress: (value) => progress.push(value),
  });
  const outcome: { state: "pending" | "resolved" | "rejected"; value?: unknown } = {
    state: "pending",
  };
  void promise.then(
    (value) => {
      outcome.state = "resolved";
      outcome.value = value;
    },
    (error: unknown) => {
      outcome.state = "rejected";
      outcome.value = error;
    },
  );
  return {
    controller,
    progress,
    outcome,
    get worker() {
      const worker = FakeWorker.instances[0];
      assert.ok(worker, "未取消的请求必须创建 Worker");
      return worker;
    },
  };
}

function assertReleased(f: ReturnType<typeof fixture>) {
  assert.equal(f.worker.terminateCalls, 1);
  assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
}

test("已取消的扫描不创建 Worker", async (t) => {
  const f = fixture(t, true);
  await Promise.resolve();
  assert.equal(f.outcome.state, "rejected");
  assert.equal((f.outcome.value as Error).name, "AbortError");
  assert.equal(FakeWorker.instances.length, 0);
});

for (const code of [0, 2]) {
  test(`未发送 done 即退出（code=${code}）必须收敛`, async (t) => {
    const f = fixture(t);
    f.worker.emit("exit", code);
    await Promise.resolve();
    assert.equal(f.outcome.state, "rejected");
    assert.match((f.outcome.value as Error).message, new RegExp(`code ${code}`));
    assertReleased(f);
  });
}

test("progress/done 保真且迟到消息不能重复结算", async (t) => {
  const f = fixture(t);
  const value = { roots: [], errors: [] };
  f.worker.emit("message", { type: "progress", progress: value });
  f.worker.emit("message", { type: "done", progress: value });
  f.worker.emit("message", { type: "progress", progress: value });
  f.worker.emit("message", { type: "done", progress: { roots: [], errors: [] } });
  f.worker.emit("exit", 1);
  await Promise.resolve();
  assert.equal(f.outcome.state, "resolved");
  assert.equal(f.outcome.value, value);
  assert.deepEqual(f.progress, [value]);
  assertReleased(f);
});

test("Worker 协议错误保留错误码并释放资源", async (t) => {
  const f = fixture(t);
  f.worker.emit("message", { type: "error", message: "synthetic failure", code: "EIO" });
  f.worker.emit("exit", 0);
  await Promise.resolve();
  assert.equal(f.outcome.state, "rejected");
  assert.equal((f.outcome.value as Error & { code: string }).code, "EIO");
  assertReleased(f);
});

test("Worker 原生错误保留错误对象", async (t) => {
  const f = fixture(t);
  const error = new Error("synthetic worker error");
  f.worker.emit("error", error);
  f.worker.emit("exit", 1);
  await Promise.resolve();
  assert.equal(f.outcome.state, "rejected");
  assert.equal(f.outcome.value, error);
  assertReleased(f);
});

test("取消得到 Worker 确认时只收敛一次", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t);
  f.controller.abort();
  assert.deepEqual(f.worker.posted, [{ type: "abort" }]);
  f.worker.emit("message", { type: "aborted", message: "synthetic abort" });
  t.mock.timers.tick(500);
  await Promise.resolve();
  assert.equal(f.outcome.state, "rejected");
  assert.equal((f.outcome.value as Error).name, "AbortError");
  assertReleased(f);
});

for (const code of [0, 1]) {
  test(`取消后 Worker 退出（code=${code}）立即返回 AbortError`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const f = fixture(t);
    f.controller.abort();
    f.worker.emit("exit", code);
    await Promise.resolve();
    assert.equal(f.outcome.state, "rejected");
    assert.equal((f.outcome.value as Error).name, "AbortError");
    assertReleased(f);
    t.mock.timers.tick(500);
    assert.equal(f.worker.terminateCalls, 1);
  });
}

test("真实 Worker 未发 done 的零码退出不会留下 pending", { timeout: 10_000 }, async () => {
  // Worker 仅执行内存 data URL，不导入业务 IO，也不遍历文件系统。
  const workerUrl = new URL("data:text/javascript,export%20%7B%7D");
  await assert.rejects(
    createStorageScanWorkerRunner({ workerUrl }).run({
      roots: [],
      signal: new AbortController().signal,
      onProgress: () => assert.fail("意外进度"),
    }),
    /storage scan worker exited with code 0/,
  );
});

test("真实 Worker 正常完成后的 exit 不覆盖结果", { timeout: 10_000 }, async () => {
  const source = `
    import { parentPort } from "node:worker_threads";
    const progress = { roots: [], errors: [] };
    parentPort.postMessage({ type: "progress", progress });
    parentPort.postMessage({ type: "done", progress });
    parentPort.close();
  `;
  const workerUrl = new URL(`data:text/javascript,${encodeURIComponent(source)}`);
  const events: unknown[] = [];
  const result = await createStorageScanWorkerRunner({ workerUrl }).run({
    roots: [],
    signal: new AbortController().signal,
    onProgress: (value) => events.push(value),
  });
  assert.deepEqual(result, { roots: [], errors: [] });
  assert.deepEqual(events, [{ roots: [], errors: [] }]);
});

test("没有取消确认时保留原有 500ms grace timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t);
  f.controller.abort();
  t.mock.timers.tick(499);
  await Promise.resolve();
  assert.equal(f.outcome.state, "pending");
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(f.outcome.state, "rejected");
  assert.equal((f.outcome.value as Error).name, "AbortError");
  assertReleased(f);
});
