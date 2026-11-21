// Session Store Port：为会话输入、消息和投影提供稳定的存储边界。
// ============================================================
import type { MessageId, PartId, SessionId, TurnId } from "./shared.js";
import type { CompactPhase, CompactReason, CompactTrigger } from "../compact/index.js";
import { type ModelSelection } from "../model/index.js";

export type TimelinePartDisplay = "separator" | "worklog";

export type TimelinePartStatus =
  | "started"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled"
  | string;

export interface TimelineModelSelection extends ModelSelection {
  label?: string;
}

export interface TimelinePartBase {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "timeline";
  display: TimelinePartDisplay;
  status?: TimelinePartStatus;
  anchorMessageId?: MessageId;
  anchorTurnId?: TurnId;
  /** 用户命令产生的 marker 查重锚点；auto/system marker 缺省。 */
  sourceCommandId?: string;
  /**
   * fork copy 降级 provenance：anchor 指向未被复制的消息/父轮时，
   * 本地 anchor 必须清空（不得参与 child 落位），原引用降级到 origin* 仅供溯源。
   */
  originAnchorMessageId?: MessageId;
  originAnchorTurnId?: TurnId;
  time?: {
    start?: number;
    end?: number;
  };
}

export interface ContextCompactionTimelinePart extends TimelinePartBase {
  timelineType: "context_compaction";
  operationId: string;
  trigger: CompactTrigger;
  phase?: CompactPhase;
  compactReason?: CompactReason;
  boundaryId?: string;
  summaryMessageId?: MessageId;
  preCompactTokenCount?: number;
  postCompactTokenCount?: number;
  truePostCompactTokenCount?: number;
  attempt?: number;
  maxAttempts?: number;
  reason?: string;
}

export interface GoalVerificationTimelinePart extends TimelinePartBase {
  timelineType: "goal_verification";
  targetId: string;
  verificationId: string;
  goalIteration?: number;
  verification?: {
    passed: boolean;
    reason: string;
    nextAction?: string | null;
  };
}

export interface SessionForkTimelinePart extends TimelinePartBase {
  timelineType: "session_fork";
  parentSessionId: SessionId;
  targetMessageId: MessageId;
  targetCheckpointId?: string;
  restoredFileCount?: number;
}

export interface ModelChangeTimelinePart extends TimelinePartBase {
  timelineType: "model_change";
  fromModel?: TimelineModelSelection;
  /** 回滚再升级后模型配置可缺失；不能因此丢掉整条历史内容。 */
  toModel?: TimelineModelSelection & { label: string };
}

/** 受管 worktree 的创建结果（docs/git/worktree.md §6.6.4）；由 Host 创建 worktree 后交给 CLI 落盘。 */
export interface WorktreeCreationFact {
  /** worktree 根目录。 */
  path: string;
  /** 检出的 commit。 */
  sha: string;
  /** 用户选择的起点；null = 源目录当前 HEAD。 */
  ref: string | null;
  /** git 与拷贝输出的末尾。 */
  output: string;
}

export interface WorktreeCreationTimelinePart extends TimelinePartBase {
  timelineType: "worktree_creation";
  worktreeCreation: WorktreeCreationFact;
}

export type TimelinePart =
  | ContextCompactionTimelinePart
  | GoalVerificationTimelinePart
  | SessionForkTimelinePart
  | ModelChangeTimelinePart
  | WorktreeCreationTimelinePart;

export type TimelinePartDraft = TimelinePart extends infer Part
  ? Part extends TimelinePart
    ? Omit<Part, "id" | "messageID" | "sessionID" | "type">
    : never
  : never;
