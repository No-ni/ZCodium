// Session Store Port：为会话输入、消息和投影提供稳定的存储边界。
// ============================================================
import type { MessageId, PartId, SessionId } from "./shared.js";
import type { FilePart } from "./session-store-message-parts.js";

export interface ToolStatePending {
  status: "pending";
  input: Record<string, unknown>;
  raw: string;
}

export interface ToolStateRunning {
  status: "running";
  input: Record<string, unknown>;
  title?: string;
  metadata?: Record<string, unknown>;
  time: {
    start: number;
  };
}

export interface ToolStateCompleted {
  status: "completed";
  input: Record<string, unknown>;
  output: string;
  title: string;
  metadata: Record<string, unknown>;
  time: {
    start: number;
    end: number;
    compacted?: number;
  };
  attachments?: FilePart[];
}

export interface ToolStateError {
  status: "error";
  input: Record<string, unknown>;
  error: string;
  metadata?: Record<string, unknown>;
  time: {
    start: number;
    end: number;
  };
}

export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError;

export interface ToolPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "tool";
  callID: string;
  /** 旧记录的本地工具声明序号；新记录改写 blockIndex，读取保留给旧数据。 */
  declarationIndex?: number;
  /**
   * assistant 块到达序号，与 text / reasoning part 共用；重试新建的 part 沿用同一序号。
   * 每次写入都必须带上：savePart 冲突更新整体替换 data，漏写一次这条消息就静默按旧数据排序。
   */
  blockIndex?: number;
  tool: string;
  state: ToolState;
  metadata?: Record<string, unknown>;
}
