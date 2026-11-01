import type { ZCodeBackgroundTaskControlItem } from "./background-task-controls.js";

export function mergeZCodeBackgroundTaskControlItems(
  current: readonly ZCodeBackgroundTaskControlItem[],
  updates: readonly ZCodeBackgroundTaskControlItem[],
): ZCodeBackgroundTaskControlItem[] {
  const jobsById = new Map(current.map((job) => [job.jobId, job] as const));
  for (const job of updates) {
    const existing = jobsById.get(job.jobId);
    if (!existing) {
      jobsById.set(job.jobId, job);
      continue;
    }
    // session.updated 载荷是 reducer 的部分更新事实；undefined 与字段缺席都不表示 clear。
    // 同 jobId 只覆盖本次携带的字段，避免状态或输出尾被解析后的稀疏 update 抹掉。
    jobsById.set(job.jobId, {
      ...existing,
      ...Object.fromEntries(Object.entries(job).filter(([, value]) => value !== undefined)),
    });
  }
  return Array.from(jobsById.values());
}
