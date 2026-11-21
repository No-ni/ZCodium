import { ModelRequestSessionType, ModelRetryBudget } from "../protocol-values/contract.js";
import type {
  ModelUsage,
  JsonSchema,
  ModelRequestSettings,
  ModelToolChoice,
  ModelToolResult,
  ModelSource,
} from "../protocol-values/contract.js";
import type { TraceContext } from "../tracing/tracer.js";
import type { ModelApiCallObservation } from "../model/observation.js";
import type {
  ModelRequestAdmission,
  ModelStreamRecoveryStatus,
  ModelStatusSink,
} from "./network-status.js";
import type {
  ModelToolCall,
  ModelTextContentBlock,
  ModelReasoningContentBlock,
  ModelInputMessage,
} from "./messages.js";
import type { ModelToolContract } from "./tool-contract.js";

export interface ModelTextRequest extends ModelRequestSettings {
  toolSearchEnabled?: boolean;
  messages: ModelInputMessage[];
  tools?: ModelToolContract[];
  toolChoice?: ModelToolChoice;
  responseJsonSchema?: JsonSchema;
  providerOptions?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  abortSignal?: AbortSignal;
  /**
   * Runtime-only hook for propagating model transport status to UI/session layers.
   * This is intentionally omitted from the JSON schema below because it is not serializable.
   */
  statusSink?: ModelStatusSink;
  /**
   * Runtime-only trace context. Serialized requests should pass trace ids through metadata.
   */
  traceContext?: TraceContext;
  /** Runtime-only、强类型的模型 API 调用分类；不会进入 Provider 请求。 */
  modelCall?: ModelApiCallObservation;
  /**
   * Runtime-only 的宿主 session 粗分类。Adapter 将它写入受控归因 header；
   * 不允许调用方通过 provider 静态 headers 覆盖。
   */
  modelRequestSessionType?: ModelRequestSessionType;
  /**
   * Runtime-only 重试预算档位（见 {@link ModelRetryBudget}）。与 modelRequestSessionType 同族：
   * 不进 JSON schema、不进 provider 请求。缺省即 `default`。
   */
  modelRetryBudget?: ModelRetryBudget;
  /**
   * Runtime-only 准入端口（见 {@link ModelRequestAdmission}）：在场时 runner 每次尝试先 acquire、
   * 结束即 release。与 statusSink 同族：不进 JSON schema、不进 provider 请求。
   */
  modelRequestAdmission?: ModelRequestAdmission;
  /**
   * Runtime-only SSE idle timeout 递增序号。0/undefined 表示首请求；
   * 每重试一次在 adapter base timeout 上加 30000ms。
   */
  streamIdleTimeoutRetryNumber?: number;
  /** Runtime-only recovery attribution；只进入 status/diagnostics，不发送给 Provider。 */
  streamRecovery?: ModelStreamRecoveryStatus;
  /**
   * Runtime-only provider stream 边界开关。compact 隐藏流用它保留首个真实 provider event
   * 与 content block provenance；tool input 提交不受此开关控制，所有请求都等待 AI SDK end。
   */
  preserveProviderStreamBoundaries?: boolean;
}

export interface ModelTextResult {
  text: string;
  /** 按到达顺序的文字块，每块带 blockIndex；`text` 仍是所有文字块直接拼接。 */
  textBlocks?: ModelTextContentBlock[];
  finishReason: string;
  usage: ModelUsage;
  reasoning?: ModelReasoningContentBlock[];
  toolCalls?: ModelToolCall[];
  toolResults?: ModelToolResult[];
  sources?: ModelSource[];
  providerMetadata?: Record<string, unknown>;
  /** 本次结果来自签名修复后的重试：调用方要在产出的 assistant 上记 signedReasoningReset。 */
  signedReasoningReset?: boolean;
}

export type ModelStreamEvent =
  | { type: "start" }
  | {
      /**
       * Compact-only replay boundary。Adapter 从 raw provider stream 提炼真实边界；
       * 无 raw provenance 的 direct tool-call 校验失败可补一个 inferred commit。
       * 事件不携带 provider 正文，也不进入 session/UI streaming。
       */
      type: "compact_stream_boundary";
      boundary: "provider_response_start" | "inferred_content_block_stop";
    }
  | {
      type: "compact_stream_boundary";
      boundary: "provider_content_block_start";
      blockType: string | null;
      index: number | null;
    }
  | {
      /** Raw delta 只携带 provenance type，不携带正文。 */
      type: "compact_stream_boundary";
      boundary: "provider_content_block_delta";
      deltaType: string | null;
      index: number | null;
    }
  | {
      type: "compact_stream_boundary";
      boundary: "provider_content_block_stop";
      index: number | null;
    }
  | {
      /** 每个 provider message_delta 覆盖当前 stop reason 状态，后续 null 会清掉先前值。 */
      type: "compact_stream_boundary";
      boundary: "provider_stop_reason";
      present: boolean;
    }
  | { type: "text_start"; id: string }
  | { type: "text_delta"; id?: string; text: string }
  | { type: "text_end"; id: string }
  | { type: "reasoning_start"; id: string; providerMetadata?: Record<string, unknown> }
  | {
      type: "reasoning_delta";
      id?: string;
      text: string;
      providerMetadata?: Record<string, unknown>;
    }
  | { type: "reasoning_end"; id: string; providerMetadata?: Record<string, unknown> }
  | { type: "tool_input_start"; id: string; toolName: string; providerExecuted?: boolean }
  | { type: "tool_input_delta"; id: string; delta: string }
  | { type: "tool_input_end"; id: string }
  | { type: "tool_call"; toolCall: ModelToolCall }
  | {
      /**
       * Provider 在服务端执行完内置工具（toolCall.providerExecuted）后随流下发的结果。
       * 客户端不执行这类工具，只用于展示、持久化和下一次请求回放。
       */
      type: "provider_tool_result";
      toolCallId: string;
      toolName: string;
      output: unknown;
      isError: boolean;
    }
  | {
      type: "finish";
      finishReason: string;
      providerMetadata?: Record<string, unknown>;
      usage: ModelUsage;
      /** 同 ModelTextResult.signedReasoningReset。 */
      signedReasoningReset?: boolean;
    }
  | { type: "error"; error: unknown };
