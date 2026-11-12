import type {
  MessageId,
  Model,
  ModelUsageRecord,
  SessionEvent,
  TraceContext,
} from "@zcode/contracts";
import type { RuntimeModelTextResult } from "../types.js";

export interface RecordModelUsageInput {
  assistantMessageId?: MessageId;
  attemptIndex?: number;
  error?: unknown;
  events: readonly SessionEvent[];
  model: Model;
  networkEventStartIndex: number;
  /** 与模型账本共用已归一化的实际 attempt；持久化失败仍交付，不另提取或合并用量。 */
  onModelUsage?: (record: ModelUsageRecord) => void | Promise<void>;
  parentUserMessageId?: MessageId;
  querySource: string;
  result?: RuntimeModelTextResult;
  startedAt: number;
  status: "completed" | "error" | "cancelled";
  toolCallCount?: number;
  traceContext: TraceContext;
}

export interface ProviderModelUsageIdentity {
  id: string;
  logicalRequestId: string;
  attemptIndex: number;
}
