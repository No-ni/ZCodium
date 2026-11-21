// -----------------------------------------------
// Collaboration Mode and Risk Level
// -----------------------------------------------

export type CollaborationMode = "plan" | "build" | "edit" | "yolo" | "guarded" | "auto";

/** 父 guarded 只收紧内部 YOLO 派生；显式的其它子模式保留各自策略。 */
export function inheritPermissionMode<T extends CollaborationMode | undefined>(
  parent: CollaborationMode | undefined,
  resolved: T,
): T | "guarded" {
  return parent === "guarded" && resolved === "yolo" ? "guarded" : resolved;
}

/**
 * 从严到宽，按各模式的默认策略排列；auto 尚未实现，不参与比较。
 * 例外：guarded 的危险命令审批先于 allow 规则，配置 allow 规则时 build/edit 可能放行 guarded 会询问的命令。
 */
const PERMISSION_MODE_STRICTNESS: readonly CollaborationMode[] = [
  "plan",
  "build",
  "edit",
  "guarded",
  "yolo",
];

/** 子模式只能收紧父模式：返回更严格的一个；任一方无法比较时继承父模式。 */
export function restrictPermissionMode(
  parent: CollaborationMode,
  child: CollaborationMode,
): CollaborationMode {
  const parentRank = PERMISSION_MODE_STRICTNESS.indexOf(parent);
  const childRank = PERMISSION_MODE_STRICTNESS.indexOf(child);
  return parentRank >= 0 && childRank >= 0 && childRank < parentRank ? child : parent;
}

export type SessionStatus = "idle" | "running" | "waiting" | "paused" | "completed" | "error";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type InputDelivery = "auto" | "start_turn" | "steer_active_turn";

export type TurnSteerRejectReason =
  | "no_active_turn"
  | "expected_turn_mismatch"
  | "turn_not_steerable"
  | "empty_input"
  | "input_too_large";

export type TurnSteerSource = "plan_approval_feedback" | "workflow_refine_feedback";

/**
 * 输入投递语义：
 * - "queue"：排队的未来意图，消费时切新 product turn（每条一轮，自己的回复/工时/edit 范围）；
 * - "guide"：对进行中工作的补充引导，内联在当前轮，不切轮。
 * runtime 注入机制两者相同（boundary 注入），差异只在产品呈现与账本语义。
 */
export type TurnSteerDeliveryMode = "guide" | "queue";

export type PermissionDecision = "allow" | "deny" | "escalate" | "modify";
