import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StorageRootSpec, StorageUsageSnapshot } from "@zcode/shared";
import type { IStorageService } from "../src/storage/contract.js";
import type {
  FsCleanerPort,
  RootsResolverPort,
  ScanRunnerPort,
  StorageScanProgress,
} from "../src/storage/app/ports.js";
import { createStorageService } from "../src/storage/app/storageService.js";

/**
 * 存储扫描启动代纪回归。
 *
 * Bug 原因：startScan 在 `await deps.roots.resolveRoots()` 之后无代纪检查即创建 job
 * 并接管 currentJob。resolveRoots 是异步端口，await 期间服务状态可被其他命令改变：
 *   1) 乱序接管：两次 startScan 在途时，先恢复的旧启动覆盖 currentJob 且永不被取消，
 *      与新扫描并发跑完两份全量扫描（done 清理条件也永不成立）；
 *   2) 取消后启动：cancelScan 到达时 job 尚未注册，早退成为 no-op，扫描稍后无视取消启动；
 *   3) dispose / clean 与在途启动交错时，同样会启动本应作废的扫描。
 *
 * 修复依据：startScan 契约「开始一次扫描；若已有进行中的 job 会先取消它」与
 * docs/specs/storage-scan-lifecycle.md 的「旧请求立即失效」；新增单调代纪计数器，
 * await 恢复后不匹配即作废（不创建 job、不接管、不发事件、不写 latestSnapshot）。
 *
 * 测试全程 hermetic：端口全部内存 mock（可 gate 的 RootsResolverPort、手动收尾的
 * ScanRunnerPort、空操作 FsCleanerPort），不写文件系统、不启动 Worker、
 * 不使用系统临时目录或真实用户数据。
 */

// 合成夹具路径，不触碰真实用户数据。
const ROOTS: StorageRootSpec[] = [
  { id: "home", path: "C:/fixture/home", hasCustomDataBaseDir: false },
  { id: "dataBaseDir", path: "C:/fixture/data", hasCustomDataBaseDir: false },
];

interface RunRecord {
  roots: StorageRootSpec[];
  finish: () => void;
  settled: Promise<"finished" | "aborted">;
}

/** 手动收尾的 runner：登记每次 run，完成/中止由测试显式驱动。 */
function createRunner() {
  const runs: RunRecord[] = [];
  const runner: ScanRunnerPort = {
    run(request) {
      let markFinished: () => void = () => {};
      const settled = new Promise<"finished" | "aborted">((resolve) => {
        markFinished = () => resolve("finished");
        request.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
      });
      runs.push({ roots: request.roots, finish: markFinished, settled });
      return settled.then((status) => {
        if (status === "aborted") {
          // 与 scanJob 的 isAbortError 约定一致：AbortError 判 cancelled。
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        }
        return { roots: [], errors: [] } satisfies StorageScanProgress;
      });
    },
  };
  return { runs, runner };
}

/** 第一次 resolveRoots 停在闸门后，后续调用立即返回（clean 的根解析不被阻塞）。 */
function createRootsResolver() {
  let releaseFirst: () => void = () => {};
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let first = true;
  const resolver: RootsResolverPort = {
    async resolveRoots() {
      if (first) {
        first = false;
        await firstGate;
      }
      return ROOTS;
    },
  };
  return { resolver, releaseFirst };
}

function createCleaner() {
  const calls = { listCandidates: 0, deleteFiles: 0 };
  const cleaner: FsCleanerPort = {
    async listCandidates() {
      calls.listCandidates += 1;
      return [];
    },
    async deleteFiles() {
      calls.deleteFiles += 1;
      return { deletedCount: 0, freedBytes: 0, failures: [] };
    },
  };
  return { calls, cleaner };
}

function createService(deps: {
  roots: RootsResolverPort;
  runner: ScanRunnerPort;
  cleaner: FsCleanerPort;
}): IStorageService {
  return createStorageService({
    roots: deps.roots,
    scanRunner: deps.runner,
    cleaner: deps.cleaner,
    now: () => 0,
    progressThrottleMs: 0,
  });
}

/** 收集进度快照；terminal 在首个非 scanning 快照时 resolve。 */
function collectProgress(service: IStorageService) {
  const snapshots: StorageUsageSnapshot[] = [];
  const terminal = new Promise<StorageUsageSnapshot>((resolve) => {
    service.onScanProgress((snapshot) => {
      snapshots.push(snapshot);
      if (snapshot.status !== "scanning") resolve(snapshot);
    });
  });
  return { snapshots, terminal };
}

/** 收尾：完成所有未结束的 run 并等其落地，避免测试间悬挂 promise。 */
async function settleRuns(runs: RunRecord[]) {
  for (const run of runs) run.finish();
  await Promise.all(runs.map((run) => run.settled));
}

// 仅为测试悬挂设置上限；生产取消依靠代际，不用超时掩盖竞态。
describe(
  "Storage scan start drops superseded or invalidated in-flight starts",
  { timeout: 10_000 },
  () => {
    it("supersedes a pending start so only the newest scan runs", async () => {
      const roots = createRootsResolver();
      const runner = createRunner();
      const service = createService({
        roots: roots.resolver,
        runner: runner.runner,
        cleaner: createCleaner().cleaner,
      });
      const progress = collectProgress(service);
      try {
        const first = service.startScan();
        const second = service.startScan();
        roots.releaseFirst();
        const [firstResult, secondResult] = await Promise.all([first, second]);

        // 只有最新一次启动创建扫描 job；旧 jobId 永不触达 runner。
        assert.equal(runner.runs.length, 1);
        assert.notEqual(firstResult.jobId, secondResult.jobId);
        await settleRuns(runner.runs);
        await progress.terminal;
        // 进度只属于最新 job，旧启动不产生任何事件。
        assert.deepEqual(
          progress.snapshots.map((snapshot) => snapshot.jobId),
          [secondResult.jobId],
        );
        assert.partialDeepStrictEqual(await service.getSnapshot(), {
          jobId: secondResult.jobId,
          status: "complete",
        });
      } finally {
        service.dispose();
      }
    });

    it("drops a start cancelled before its roots resolve", async () => {
      const roots = createRootsResolver();
      const runner = createRunner();
      const service = createService({
        roots: roots.resolver,
        runner: runner.runner,
        cleaner: createCleaner().cleaner,
      });
      const progress = collectProgress(service);
      try {
        const pending = service.startScan();
        // 内部 API 防御（非 UI 现路径：UI 总是在收到 jobId 后才取消）：
        // jobId 由服务内 jobCounter 生成（首个为 scan-1）；在 resolveRoots 放行前取消
        // 「最近一次启动意图」，验证取消击中尚未注册的 job 时扫描不得启动。
        await service.cancelScan("scan-1");
        roots.releaseFirst();
        assert.deepEqual(await pending, { jobId: "scan-1" });
        assert.equal(runner.runs.length, 0);
        assert.deepEqual(progress.snapshots, []);
        assert.equal(await service.getSnapshot(), null);
      } finally {
        service.dispose();
      }
    });

    it("drops a start invalidated by dispose before its roots resolve", async () => {
      const roots = createRootsResolver();
      const runner = createRunner();
      const service = createService({
        roots: roots.resolver,
        runner: runner.runner,
        cleaner: createCleaner().cleaner,
      });
      try {
        const pending = service.startScan();
        service.dispose();
        roots.releaseFirst();
        assert.deepEqual(await pending, { jobId: "scan-1" });
        // 销毁后不得再有扫描触达 runner。
        assert.equal(runner.runs.length, 0);
      } finally {
        service.dispose();
      }
    });

    it("drops a start invalidated by clean before its roots resolve", async () => {
      const roots = createRootsResolver();
      const runner = createRunner();
      const cleaner = createCleaner();
      const service = createService({
        roots: roots.resolver,
        runner: runner.runner,
        cleaner: cleaner.cleaner,
      });
      try {
        const pending = service.startScan();
        // clean 自己走第二次 resolveRoots（立即返回），与在途启动交错。
        await service.clean({ rootId: "home", categoryId: "logs" });
        assert.equal(cleaner.calls.deleteFiles, 1);
        roots.releaseFirst();
        assert.deepEqual(await pending, { jobId: "scan-1" });
        // 清理进行时不得又启动一份全量扫描与删除并发。
        assert.equal(runner.runs.length, 0);
      } finally {
        service.dispose();
      }
    });

    it("keeps an unknown or stale cancel from invalidating a pending start", async () => {
      const roots = createRootsResolver();
      const runner = createRunner();
      const service = createService({
        roots: roots.resolver,
        runner: runner.runner,
        cleaner: createCleaner().cleaner,
      });
      try {
        const pending = service.startScan();
        // 守卫：取消的不是「最近一次启动意图」时不得推进代纪，否则在途启动被误杀。
        await service.cancelScan("scan-unknown");
        await service.cancelScan("scan-0");
        roots.releaseFirst();
        const { jobId } = await pending;
        assert.equal(jobId, "scan-1");
        assert.equal(runner.runs.length, 1);
        await settleRuns(runner.runs);
      } finally {
        service.dispose();
      }
    });

    it("keeps the single-scan happy path and stores the terminal snapshot", async () => {
      const roots = createRootsResolver();
      const runner = createRunner();
      const service = createService({
        roots: roots.resolver,
        runner: runner.runner,
        cleaner: createCleaner().cleaner,
      });
      const progress = collectProgress(service);
      try {
        const pending = service.startScan();
        roots.releaseFirst();
        const { jobId } = await pending;
        assert.equal(runner.runs.length, 1);
        assert.equal(await service.getSnapshot(), null);
        await settleRuns(runner.runs);
        const terminal = await progress.terminal;
        assert.equal(terminal.status, "complete");
        assert.equal(terminal.jobId, jobId);
        assert.equal(await service.getSnapshot(), terminal);
      } finally {
        service.dispose();
      }
    });

    it("keeps the cancelled terminal snapshot and ignores unknown job cancels", async () => {
      const roots = createRootsResolver();
      const runner = createRunner();
      const service = createService({
        roots: roots.resolver,
        runner: runner.runner,
        cleaner: createCleaner().cleaner,
      });
      const progress = collectProgress(service);
      try {
        const pending = service.startScan();
        roots.releaseFirst();
        const { jobId } = await pending;
        await service.cancelScan(jobId);
        const terminal = await progress.terminal;
        // 取消态快照必须继续入库（latestJobId 过滤语义不变）。
        assert.equal(terminal.status, "cancelled");
        assert.equal(await service.getSnapshot(), terminal);
        await runner.runs[0]!.settled;
        // 未知/陈旧 jobId 的取消是 no-op：不产生新扫描，也不改动已入库快照。
        await service.cancelScan("scan-unknown");
        assert.equal(runner.runs.length, 1);
        assert.equal(await service.getSnapshot(), terminal);
      } finally {
        service.dispose();
      }
    });
  },
);
