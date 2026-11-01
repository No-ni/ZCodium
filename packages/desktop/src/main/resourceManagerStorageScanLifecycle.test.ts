import assert from "node:assert/strict";
import test from "node:test";
import { createResourceManagerStorageScanLifecycle } from "./resourceManagerStorageScanLifecycle.js";

interface Subscriber {
  id: number;
  destroyed: boolean;
}
interface StartResult {
  jobId: string;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const sender: Subscriber = { id: 1, destroyed: false };
  const replacement: Subscriber = { id: 2, destroyed: false };
  let subscriber: Subscriber | null = sender;
  let serviceReads = 0;
  let cancelGate: ReturnType<typeof deferred<void>> | null = null;
  const starts: Array<ReturnType<typeof deferred<StartResult>>> = [];
  const cancelled: string[] = [];
  const service = {
    startScan() {
      const start = deferred<StartResult>();
      starts.push(start);
      return start.promise;
    },
    async cancelScan(jobId: string) {
      cancelled.push(jobId);
      await cancelGate?.promise;
    },
  };
  const lifecycle = createResourceManagerStorageScanLifecycle<Subscriber>({
    getService() {
      serviceReads++;
      return service;
    },
    isSubscriberActive(candidate) {
      return subscriber === candidate && !candidate.destroyed;
    },
  });
  return {
    lifecycle,
    sender,
    replacement,
    cancelled,
    setSubscriber(value: Subscriber | null) {
      subscriber = value;
    },
    blockCancellation() {
      cancelGate = deferred<void>();
      return cancelGate;
    },
    startAt(index: number) {
      const start = starts[index];
      assert.ok(start, "请求必须同步进入 service.startScan，再等待回应");
      return start;
    },
    get serviceReads() {
      return serviceReads;
    },
  };
}

test("未启动的窗口关闭不创建扫描服务", async () => {
  const f = fixture();
  await f.lifecycle.close();
  assert.equal(f.serviceReads, 0);
  assert.deepEqual(f.cancelled, []);
});

test("正常启动保留回应对象，关闭按已知 jobId 取消", async () => {
  const f = fixture();
  const pending = f.lifecycle.startScan(f.sender);
  const reply = { jobId: "scan-1" };
  f.startAt(0).resolve(reply);
  assert.equal(await pending, reply);
  assert.deepEqual(f.cancelled, []);
  await f.lifecycle.close();
  assert.deepEqual(f.cancelled, ["scan-1"]);
});

test("窗口先关闭时必须取消迟到的启动回应", async () => {
  const f = fixture();
  const pending = f.lifecycle.startScan(f.sender);
  f.setSubscriber(null);
  await f.lifecycle.close();
  assert.deepEqual(f.cancelled, []);
  const reply = { jobId: "scan-1" };
  f.startAt(0).resolve(reply);
  assert.equal(await pending, reply);
  assert.deepEqual(f.cancelled, ["scan-1"]);
  await f.lifecycle.close();
  assert.deepEqual(f.cancelled, ["scan-1"]);
});

test("同窗口乱序回应不覆盖关闭时要取消的最新任务", async () => {
  const f = fixture();
  const first = f.lifecycle.startScan(f.sender);
  const second = f.lifecycle.startScan(f.sender);
  const firstReply = { jobId: "scan-1" };
  const secondReply = { jobId: "scan-2" };
  f.startAt(1).resolve(secondReply);
  assert.equal(await second, secondReply);
  f.startAt(0).resolve(firstReply);
  assert.equal(await first, firstReply);
  await f.lifecycle.close();
  assert.deepEqual(f.cancelled, ["scan-1", "scan-2"]);
});

test("subscriber 被替换后原窗口迟到回应不能留下扫描", async () => {
  const f = fixture();
  const pending = f.lifecycle.startScan(f.sender);
  f.setSubscriber(f.replacement);
  f.startAt(0).resolve({ jobId: "scan-1" });
  await pending;
  assert.deepEqual(f.cancelled, ["scan-1"]);
});

test("sender 已销毁时不依赖 closed 回调也取消迟到回应", async () => {
  const f = fixture();
  const pending = f.lifecycle.startScan(f.sender);
  f.sender.destroyed = true;
  f.startAt(0).resolve({ jobId: "scan-1" });
  await pending;
  assert.deepEqual(f.cancelled, ["scan-1"]);
});

test("等待最新回应期间取消未知 id 不作废该回应", async () => {
  const f = fixture();
  const pending = f.lifecycle.startScan(f.sender);
  await f.lifecycle.cancelScan("unknown");
  f.startAt(0).resolve({ jobId: "scan-1" });
  await pending;
  assert.deepEqual(f.cancelled, ["unknown"]);
  await f.lifecycle.close();
  assert.deepEqual(f.cancelled, ["unknown", "scan-1"]);
});

test("显式取消已知任务后关闭不重复取消", async () => {
  const f = fixture();
  const pending = f.lifecycle.startScan(f.sender);
  f.startAt(0).resolve({ jobId: "scan-1" });
  await pending;
  await f.lifecycle.cancelScan("scan-1");
  await f.lifecycle.close();
  assert.deepEqual(f.cancelled, ["scan-1"]);
});

test("关闭取消跨 await 时不能清掉后来接受的新任务", async () => {
  const f = fixture();
  const first = f.lifecycle.startScan(f.sender);
  f.startAt(0).resolve({ jobId: "scan-1" });
  await first;
  const gate = f.blockCancellation();
  const closing = f.lifecycle.close();
  f.setSubscriber(f.replacement);
  const second = f.lifecycle.startScan(f.replacement);
  f.startAt(1).resolve({ jobId: "scan-2" });
  await second;
  gate.resolve();
  await closing;
  await f.lifecycle.close();
  assert.deepEqual(f.cancelled, ["scan-1", "scan-2"]);
});

test("startScan 失败保留原始错误且不伪造取消", async () => {
  const f = fixture();
  const pending = f.lifecycle.startScan(f.sender);
  const failure = new Error("roots resolution failed");
  f.startAt(0).reject(failure);
  await assert.rejects(pending, (error) => error === failure);
  assert.deepEqual(f.cancelled, []);
});
