// Session Store Port：为会话输入、消息和投影提供稳定的存储边界。
// ============================================================
import type { MessageId, TurnId } from "./shared.js";
import type { SessionGoal } from "../tools/target.js";

export type MessageSemanticsOrigin =
  | "real_user"
  | "agent_runtime"
  | "system"
  | "migration"
  | "import";

export type MessageSemanticsKind =
  | "user_prompt"
  | "slash_command"
  | "system_reminder"
  | "background_notification"
  | "subagent_notification"
  | "todo_reminder"
  | "rewind_notice"
  | "fork_notice"
  | "timeline_event"
  | "compact_summary"
  | "shared_context"
  | "assistant_response";

export interface MessageSemantics {
  origin: MessageSemanticsOrigin;
  kind: MessageSemanticsKind;
  source?: string;
  commandName?: string;
  uiVisibility: "visible" | "hidden" | "debug";
  providerVisibility: "visible" | "hidden";
  transcriptVisibility: "visible" | "hidden";
}

// v4 投影锚点词表（userInput.origin）。
// 与 MessageSemanticsOrigin 并存不互替：semantics.origin 是旧读侧语义，
// anchor.origin 是新协议 row 派生依据；老值由读侧只读映射。
export const MESSAGE_ANCHOR_ORIGINS = [
  "realUser",
  "backgroundResult",
  "goalContinuation",
  "mailbox",
  "synthetic",
] as const;

export type MessageAnchorOrigin = (typeof MESSAGE_ANCHOR_ORIGINS)[number];

/**
 * stable fork 的 fork 点 goal 事实。undefined 只表示旧数据；新数据必须显式写 none
 * 或完整快照，避免 fork 时读取 parent 当前 goal 冒充历史状态。
 */
export type StableForkGoalBoundaryMetadata =
  | { kind: "none" }
  | {
      kind: "snapshot";
      target: SessionGoal;
      verificationEntryIds: string[];
    };

/**
 * v4 transcript 锚点（清单）：全部 optional，
 * 走 message JSON blob 的 additive 演进，历史数据留空、读侧宽容降级。
 * sourceCommandId 是命令幂等的 transcript 兜底查重键，
 * 由 v4 command inbox 铺路后写入（接线）。
 */
export interface MessageProjectionAnchor {
  turnId?: TurnId;
  origin?: MessageAnchorOrigin;
  sourceCommandId?: string;
  /** 最终 assistant 固化当前 query 的历史轮次，供 cold hydration 精确恢复。 */
  historyRoundCount?: number;
  /** 新数据的 stable fork 固定边界；历史消息缺省，由唯一 resolver 无歧义时惰性补写。 */
  productTurnId?: string;
  orderedMessageIds?: MessageId[];
  boundaryMessageId?: MessageId;
  goalBoundary?: StableForkGoalBoundaryMetadata;
}
