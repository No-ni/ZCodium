// Session Store Port：为会话输入、消息和投影提供稳定的存储边界。
// ============================================================
import type { SessionId } from "./shared.js";
import type { SessionGoal, GoalStatus } from "../tools/target.js";
import type { SessionInfo, CreateSessionInput } from "./session-store-session-info.js";
import type { MessageWithParts } from "./session-store-message.js";
import type { SessionEntryInfo, SessionInputDelivery } from "./session-store-entries.js";

/** V4 stable fork resolver 固定的目标 product turn segment。 */
export interface StableForkTargetMetadata {
  productTurnId: string;
  transcriptTurnId: string;
  orderedMessageIds: string[];
  boundaryMessageId: string;
}

/** 与 child session 同事务落盘的命令幂等事实。 */
export interface ForkChildSessionMetadata {
  parentSessionId: string;
  sourceCommandId: string;
  forkTarget: StableForkTargetMetadata;
}

export type ForkCommandResult =
  | { type: "forkAssistant"; sessionId: string }
  | { type: "createSelectionSideSession"; sessionId: string }
  | { type: "editUserQuery"; disposition: "fork"; sessionId: string };

/**
 * 数据库内 fork 的规划输入。messages 只供选择边界和改写引用：正文、文件 URL、
 * 工具输入/输出等载荷已省略，不能用于展示或模型请求。隐藏系统提醒保留选型所需文本。
 * build 必须同步、无 I/O，返回的 copySources 指向该快照；源记录在提交前保持不变。
 */
export interface ForkFromSourceInput {
  sessionID: SessionId;
  build(source: { session: SessionInfo; messages: MessageWithParts[] }): ForkCommitBundle;
}

/**
 * conversation fork 的唯一原子提交载荷。core 在内存完成 remap；adapter 不参与业务裁决，
 * 只保证 child/copy/goal/entries/input/parent command fact 全有或全无。
 */
export interface ForkCommitBundle {
  child: CreateSessionInput;
  messages: MessageWithParts[];
  entries: SessionEntryInfo[];
  /** 存储复制来源（目标 ID -> 父记录 ID）；用于数据库复制/旧字段保留，不参与模型选择。 */
  copySources?: { messages: Record<string, string>; parts: Record<string, string> };
  goal?: { source: SessionGoal; status: GoalStatus };
  initialInput?: {
    id: string;
    sessionID: SessionId;
    kind: string;
    delivery: SessionInputDelivery;
    payload: { text: string; [key: string]: unknown };
  };
  commandFact: {
    parentSessionId: string;
    sourceCommandId: string;
    ack: {
      commandId: string;
      status: "accepted";
      revisionAtDecision: number;
      result: ForkCommandResult;
    };
    metadata: Record<string, unknown>;
  };
}

/**
 * 同一 session 的多条消息及其 part 按顺序写入，全有或全无。
 * 用于 compaction 的请求前公告、summary 与附件，以及空闲整批通知（一条消息多个文本 part）。
 */
export interface MessageCommitBundle {
  sessionID: SessionId;
  messages: MessageWithParts[];
}

/** 分享导入的单事务载荷：新 session、唯一 model-only 上下文和 provenance 全有或全无。 */
export interface SharedContextImportCommitBundle {
  session: CreateSessionInput;
  contextMessage: MessageWithParts;
  provenance: SessionEntryInfo;
}

export type SharedContextImportStatus = "pending" | "reserved" | "attached" | "discarded";

export interface SharedContextImportTransition {
  sessionID: SessionId;
  contextId: string;
  expectedStatus: SharedContextImportStatus | readonly SharedContextImportStatus[];
  status: SharedContextImportStatus;
  /** queue/input identity or accepted user message identity for audit/recovery. */
  sourceId?: string;
}
