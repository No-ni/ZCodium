import { z } from "zod";

/**
 * 受管 worktree 的创建结果（docs/git/worktree.md §6.6.4）。CLI 把它写成会话历史中的
 * timeline part（timelineType = "worktree_creation"），V4 投影为 worktreeCreated 标记。
 */
export const worktreeCreationRecordSchema = z
  .object({
    /** worktree 根目录。 */
    path: z.string().trim().min(1),
    /** 检出的 commit。 */
    sha: z.string().trim().min(1),
    /** 用户选择的起点；null = 源目录当前 HEAD。 */
    ref: z.string().min(1).nullable(),
    /** git 与拷贝输出的末尾。 */
    output: z.string().max(64 * 1024),
  })
  .strict();

export type WorktreeCreationRecord = z.infer<typeof worktreeCreationRecordSchema>;

/**
 * forkAssistant 把子会话放到同一 workspace 下的另一个 cwd（受管 worktree，§8.2）。
 * childSessionId 由 Host 预分配。strict：未声明字段直接拒绝，不静默丢弃。
 */
export const forkTargetCwdSchema = z
  .object({
    cwd: z.string().trim().min(1),
    childSessionId: z.string().trim().min(1),
    worktreeCreation: worktreeCreationRecordSchema,
  })
  .strict();

export type ForkTargetCwd = z.infer<typeof forkTargetCwdSchema>;
