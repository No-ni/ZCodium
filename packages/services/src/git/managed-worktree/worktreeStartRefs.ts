import type { ManagedWorktreeStartRefs } from "@zcode/shared";
import type { SourceRepository } from "./worktreeTopology.js";
import type { WorktreeRun } from "./worktreeFiles.js";
export async function readWorktreeStartRefs(
  run: WorktreeRun,
  resolveSourceRepository: (path: string) => Promise<SourceRepository | null>,
  request: {
    sourcePath: string;
  },
): Promise<ManagedWorktreeStartRefs | null> {
  const source = await resolveSourceRepository(request.sourcePath);
  if (!source) return null;
  // 起点从 sourcePath 所在 checkout 解析，与 create 使用的 checkoutRoot 保持一致。
  const [headResult, branchResult, refsResult] = await Promise.all([
    run(source.checkoutRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]),
    run(source.checkoutRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    run(source.checkoutRoot, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]),
  ]);
  const sha = headResult.exitCode === 0 ? headResult.stdout.trim() : "";
  const localBranches: string[] = [];
  const remoteBranches: string[] = [];
  for (const ref of refsResult.stdout.split(/\r?\n/).filter(Boolean)) {
    if (ref.startsWith("refs/heads/")) localBranches.push(ref.slice("refs/heads/".length));
    // <remote>/HEAD 是符号引用，不是可选的起点分支。
    else if (ref.startsWith("refs/remotes/") && !ref.endsWith("/HEAD"))
      remoteBranches.push(ref.slice("refs/remotes/".length));
  }
  return {
    head: sha
      ? {
          sha,
          branchName: branchResult.exitCode === 0 ? branchResult.stdout.trim() || null : null,
        }
      : null,
    localBranches,
    remoteBranches,
  };
}
