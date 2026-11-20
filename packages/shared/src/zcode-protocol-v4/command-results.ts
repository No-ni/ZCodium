import { localTtftClockSchema } from "../local-ttft/contract.js";
import { z } from "zod";
import { turnHeaderRowSchema } from "./rows.js";
import { v4ConversationFileRewindPreviewResultSchema } from "./transport.js";
import { amendWorkflowRunSettingsResultSchema } from "./workflow-run-settings-command.js";

// ── ACK ──
/** 同一审批已提交后的重试原因码。只有原权限可继续发布，不得据失败回执更新偏好。 */
export const permissionGrantCommittedReasons = {
  guarded: "fault.permissionGrant.committed.guarded",
  yolo: "fault.permissionGrant.committed.yolo",
} as const;

export function committedPermissionGrantMode(reasonCode: string | undefined) {
  if (reasonCode === permissionGrantCommittedReasons.guarded) return "guarded";
  if (reasonCode === permissionGrantCommittedReasons.yolo) return "yolo";
  return undefined;
}

export const commandResultSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.enum(["createSession", "createSelectionSideSession", "forkAssistant"]),
    sessionId: z.string(),
    input: z
      .object({
        delivery: z.enum(["startNow", "queue", "guide"]),
        inputId: z.string(),
        // Core admission ACK 不等待 TurnStarted；messageId 可能由后续事件补齐。
        messageId: z.string().optional(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("resolveInteraction"),
    resolvedBy: z.object({ clientId: z.string(), optionId: z.string().optional() }),
  }),
  z.object({
    type: z.literal("applyFileRewind"),
    applied: z.boolean(),
    preview: v4ConversationFileRewindPreviewResultSchema,
    response: z.string(),
  }),
  z.object({
    type: z.literal("editUserQuery"),
    // fork 仅保留旧 ACK 解码兼容；新 editUserQuery 不再生成 child session。
    disposition: z.enum(["rewind", "fork", "blocked"]),
    sessionId: z.string().min(1),
    reasonCode: z.string().min(1).optional(),
    preview: v4ConversationFileRewindPreviewResultSchema.optional(),
  }),
  z.object({
    // startSavedWorkflow accepted ACK：
    // runId 联接启动轮 run 卡状态 / 通知 / 侧板；toolCallId = launch-<uuid>，联接合成 CreateWorkflow 轮。
    type: z.literal("startSavedWorkflow"),
    runId: z.string().min(1),
    toolCallId: z.string().min(1),
  }),
  amendWorkflowRunSettingsResultSchema,
  z.object({
    // messageId 只在 TurnStarted 后作为旁路归因补齐；Core admission ACK 不等待
    // projection commit，不能把 messageId 作为输入 accepted 的必要条件。
    type: z.literal("inputAccepted"),
    delivery: z.enum(["startNow", "queue", "guide"]),
    inputId: z.string(),
    messageId: z.string().optional(),
  }),
  z.object({
    // restart discarded 过去只返回一个无差别 fault，renderer 无法区分
    // runtime-local queue 与仍需人工确认的 startNow。delivery 来自 session_input
    // 持久事实，不能由客户端按当前 UI phase 猜测。
    type: z.literal("inputDisposition"),
    delivery: z.enum(["startNow", "queue", "guide"]),
  }),
]);

export type CommandResult = z.infer<typeof commandResultSchema>;

export const commandAckSchema = z.object({
  /** 会话创建期采用的 App Memory 开关；旧发送端缺省表示未知。 */
  memoryEnabled: z.boolean().optional(),
  ttftExcluded: z.literal("capacity").optional(),
  commandId: z.string(),
  // accepted 不承诺跨 CLI 进程存活；最终收口以权威数据（sourceCommandId）为准。
  status: z.enum(["accepted", "rejected", "stale", "duplicate", "noop", "failed"]),
  // rejected/stale/noop/failed 必带；= guard id 或 fault code（命名空间）。
  reasonCode: z.string().optional(),
  message: z.string().optional(),
  revisionAtDecision: z.number(),
  // duplicate 回放缓存结果；accepted 亦可即时带（fork）。
  result: commandResultSchema.optional(),
});

export type CommandAck = z.infer<typeof commandAckSchema>;

// ── commands/query ──
/**
 * commands/query 读取命令记录失败时的 reasonCode（status 为 failed）。它表示"无法确认命令是否执行"，
 * 不表示命令执行失败；调用方不能据此做破坏性清理（docs/git/worktree.md §3.5）。
 */
export const COMMAND_QUERY_UNAVAILABLE_REASON = "fault.command.queryUnavailable" as const;

export const commandKeySchema = z
  .object({
    // null 只属于全局/createSession 幂等桶；session 命令必须携带 sessionId。
    sessionId: z.string().nullable(),
    commandId: z.string().min(1),
  })
  .strict();

export type CommandKey = z.infer<typeof commandKeySchema>;

export const commandsQueryParamsSchema = z
  .object({ commands: z.array(commandKeySchema).min(1).max(64), clock: z.literal(true).optional() })
  .strict()
  .refine(
    (params) => !params.clock || params.commands.every((key) => key.sessionId === null),
    "clock probes cannot query session commands",
  );

export type CommandsQueryParams = z.infer<typeof commandsQueryParamsSchema>;

// 命令对应回合的当前状态：owner 全量投影中 sourceCommandId 匹配的第一个 turnHeader。
// 修复原因：快照只下发 60 行尾窗，长回合的 header 会滚出窗口，客户端据此判定 wait 结果会得到
// unknown，审批也匹配不到回合。由 owner 直接给出，不受尾窗限制；只出现在 session bucket。
export const commandQueryTurnSchema = z
  .object({ turnId: turnHeaderRowSchema.shape.turnId, state: turnHeaderRowSchema.shape.state })
  .strict();

export type CommandQueryTurn = z.infer<typeof commandQueryTurnSchema>;

export const commandQueryItemSchema = z
  .object({
    key: commandKeySchema,
    result: z.union([commandAckSchema, z.literal("unknown")]),
    turn: commandQueryTurnSchema.optional(),
  })
  .strict()
  .refine((item) => !item.turn || item.key.sessionId !== null, "global commands carry no turn");

export type CommandQueryItem = z.infer<typeof commandQueryItemSchema>;

export const commandsQueryResultSchema = z
  .object({
    results: z.array(commandQueryItemSchema).min(1).max(64),
    clock: localTtftClockSchema.optional(),
  })
  .strict();

export type CommandsQueryResult = z.infer<typeof commandsQueryResultSchema>;
