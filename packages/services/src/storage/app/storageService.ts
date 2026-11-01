/**
 * IStorageService 实现：扫描 job、最近快照、清理的唯一 owner。
 * 不做 IO；根目录、遍历、删除、系统定位全部通过 ports 注入。
 */
import { Emitter } from "@zcode/rpc";
import type { IStorageService } from "../contract.js";
import { planStorageClean } from "../domain/cleanPlan.js";
import { getStorageCategoryCleanability, getStorageCleanScopes } from "../domain/storageCatalog.js";
import type { StorageRootId, StorageRootSpec, StorageUsageSnapshot } from "@zcode/shared";
import type { FsCleanerPort, RootsResolverPort, ScanRunnerPort } from "./ports.js";
import { createScanJob, type ScanJob } from "./scanJob.js";

interface StorageServiceDependencies {
  roots: RootsResolverPort;
  scanRunner: ScanRunnerPort;
  cleaner: FsCleanerPort;
  now?: () => number;
  /** 进度事件最小间隔，默认 300ms。 */
  progressThrottleMs?: number;
}

const DEFAULT_STORAGE_PROGRESS_THROTTLE_MS = 300;

export function createStorageService(deps: StorageServiceDependencies): IStorageService {
  const now = deps.now ?? Date.now;
  const throttleMs = deps.progressThrottleMs ?? DEFAULT_STORAGE_PROGRESS_THROTTLE_MS;
  const progressEmitter = new Emitter<StorageUsageSnapshot>();
  let currentJob: ScanJob | null = null;
  let latestSnapshot: StorageUsageSnapshot | null = null;
  let latestJobId: string | null = null;
  let jobCounter = 0;
  // startScan 意图代纪。resolveRoots 是异步端口，await 期间新的 startScan /
  // cancelScan / clean / dispose 都可能改变服务状态；恢复后不匹配的启动意图必须作废。
  // 代纪刻意不与 latestJobId 复用：后者同时是快照入库过滤器，必须让被取消 job 的
  // 终态快照继续入库（见下方 emit 注释与 docs/specs/storage-scan-lifecycle.md）。
  let scanIntentGeneration = 0;

  function cancelCurrentJob(): void {
    // 取消/清理/销毁/被新扫描取代都使尚未注册的在途启动意图作废。
    scanIntentGeneration += 1;
    currentJob?.cancel();
    currentJob = null;
  }

  async function resolveRoot(rootId: StorageRootId): Promise<StorageRootSpec> {
    const root = (await deps.roots.resolveRoots()).find((candidate) => candidate.id === rootId);
    if (!root) throw new Error(`storage root not available: ${rootId}`);
    return root;
  }

  return {
    async startScan() {
      cancelCurrentJob();
      const generation = ++scanIntentGeneration;
      const jobId = `scan-${++jobCounter}`;
      latestJobId = jobId;
      const roots = await deps.roots.resolveRoots();
      // 竞态根因（修复依据）：resolveRoots 是异步端口，await 期间 UI 可能已切走/取消/
      // 重扫/清理/销毁。旧实现此时仍创建 job 并接管 currentJob：先恢复的旧 job 会覆盖
      // 新 job 且永不被取消（两份全量扫描并发跑完），取消后到达的 job 也会无视取消启动。
      // 代纪不匹配时只返回 jobId：不创建 job、不接管、不发事件、不写 latestSnapshot；
      // 调用方对该 jobId 的取消会因 currentJob 不匹配而无害 no-op。
      if (generation !== scanIntentGeneration) {
        return { jobId };
      }
      const job = createScanJob({
        jobId,
        roots,
        runner: deps.scanRunner,
        now,
        throttleMs,
        emit: (snapshot) => {
          // 用 currentJob 判断会在用户主动 cancelScan 后（currentJob 已清空）丢掉取消态快照。
          // 这里按「最近一次启动的 job」判断：旧 job 被新 job 取代后发出的尾包不能覆盖新 job 的快照。
          if (jobId === latestJobId) {
            latestSnapshot = snapshot;
          }
          progressEmitter.fire(snapshot);
        },
      });
      currentJob = job;
      void job.done.then(() => {
        if (currentJob?.jobId === jobId) currentJob = null;
      });
      return { jobId };
    },

    async cancelScan(jobId) {
      if (currentJob?.jobId === jobId) {
        cancelCurrentJob();
        return;
      }
      // 取消可能早于 startScan 注册完成（resolveRoots 在途）：若取消的正是最近一次
      // 启动意图，推进代纪使该在途启动作废，避免「取消后仍然启动」跑完整个扫描。
      // 仅匹配 latestJobId 才推进：取消陈旧/未知 job 不得误杀更新的启动意图。
      if (jobId === latestJobId) {
        scanIntentGeneration += 1;
      }
    },

    async getSnapshot() {
      return latestSnapshot;
    },

    onScanProgress: progressEmitter.event,

    async clean(request) {
      if (getStorageCategoryCleanability(request.categoryId) === "none") {
        throw new Error(`storage category is not cleanable: ${request.categoryId}`);
      }
      // 清理会改变磁盘内容，进行中的扫描结果会失真；先取消，UI 在清理后重新扫描。
      cancelCurrentJob();
      const root = await resolveRoot(request.rootId);
      const scopes = getStorageCleanScopes(request.categoryId);
      const candidates = await deps.cleaner.listCandidates(root.path, scopes);
      const plan = planStorageClean({
        categoryId: request.categoryId,
        candidates,
        context: { rootId: root.id, hasCustomDataBaseDir: root.hasCustomDataBaseDir },
        now: now(),
      });
      const result = await deps.cleaner.deleteFiles(root.path, plan.targets, {
        keepDirectories: scopes.map((scope) => scope.prefix),
      });
      return { ...result, skippedCount: plan.skippedCount };
    },

    dispose() {
      cancelCurrentJob();
      progressEmitter.dispose();
    },
  };
}
