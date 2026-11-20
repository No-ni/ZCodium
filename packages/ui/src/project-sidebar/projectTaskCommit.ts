import type { ProjectTaskRef } from "./contract.js";
export interface PendingProjectTaskCommit {
  target: ProjectTaskRef;
  commit(): void;
  organize?(): Promise<void>;
  finish(error?: unknown): void;
}
export function waitForProjectTaskCommit(
  pendingCommits: Set<PendingProjectTaskCommit>,
  refresh: () => Promise<void>,
  target: ProjectTaskRef,
  commit: () => void,
  signal?: AbortSignal,
  organize?: () => Promise<void>,
) {
  if (signal?.aborted && !organize) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const complete = (error?: unknown) => {
      signal?.removeEventListener("abort", cancel);
      if (error) reject(error);
      else resolve();
    };
    const cancel = () => {
      // 导航取消立即结束 UI 等待；尚未确认的组织意图保留到真实行到达，不丢掉已 accepted 的 placement。
      if (!organize) pendingCommits.delete(pending);
      complete();
    };
    const pending = {
      target,
      organize,
      commit: () => {
        if (!signal?.aborted) commit();
      },
      finish(error?: unknown) {
        pendingCommits.delete(pending);
        complete(error);
      },
    };
    pendingCommits.add(pending);
    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
    void refresh();
  });
}
