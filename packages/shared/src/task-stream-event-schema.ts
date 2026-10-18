import { z } from "zod";
import type { TaskStreamMirrorableEvent } from "./zcode-task-types-core.js";
import {
  zcodePermissionResponseSchema,
  zcodeSessionGoalVerificationSchema,
} from "./zcode-protocol-legacy-types.js";

const identifier = z.string().trim().min(1);
const envelope = z.object({
  taskId: identifier,
  traceId: identifier,
  inputId: identifier.optional(),
});
const usage = z.object({
  inputTokens: z.number().finite(),
  outputTokens: z.number().finite(),
  totalTokens: z.number().finite(),
  reasoningTokens: z.number().finite().optional(),
  cachedInputTokens: z.number().finite().optional(),
  cachedWriteInputTokens: z.number().finite().optional(),
});
const selectValue = z.object({ value: z.string(), name: z.string() }).passthrough();
const configOption = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.enum(["select", "boolean"]),
    currentValue: z.union([z.string(), z.boolean()]),
    options: z.array(selectValue).optional(),
  })
  .passthrough();
const elicitationOption = z.object({ value: z.string(), label: z.string() }).passthrough();

function event<Type extends string, Shape extends z.ZodRawShape>(type: Type, shape: Shape) {
  return envelope.extend({ type: z.literal(type), ...shape }).passthrough();
}

// 旧校验只检查通用信封，缺少 content 的 chunk 也会进入正文合并；按已有事件联合校验必要载荷。
// 保留扩展字段以兼容 legacy 元数据，事件判别字和必要字段仍以共享类型为准。
export const taskStreamMirrorableEventSchema: z.ZodType<TaskStreamMirrorableEvent> =
  z.discriminatedUnion("type", [
    event("agent_message_chunk", { content: z.string() }),
    event("agent_thought_chunk", { content: z.string() }),
    event("tool_call", {
      toolId: identifier,
      input: z.unknown(),
      kind: z.string(),
      title: z.string(),
      raw: z.unknown(),
    }),
    event("tool_call_update", {
      toolId: identifier,
      status: z.enum(["pending", "in_progress", "completed", "failed", "denied", "stopped"]),
      raw: z.unknown(),
    }),
    event("plan", {
      steps: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          status: z.enum(["pending", "in_progress", "completed"]),
        }),
      ),
    }),
    event("permission_request", {
      requestId: identifier,
      description: z.string(),
      kind: z.string(),
      options: z.array(
        z
          .object({
            optionId: identifier,
            kind: z.string(),
            name: z.string(),
            response: zcodePermissionResponseSchema,
          })
          .passthrough(),
      ),
      raw: z.unknown(),
    }),
    event("permission_response", {
      requestId: identifier,
      optionId: identifier,
      response: zcodePermissionResponseSchema,
    }),
    event("elicitation_request", {
      requestId: identifier,
      message: z.string(),
      options: z.array(elicitationOption),
    }),
    event("elicitation_response", {
      requestId: identifier,
      action: z.enum(["accept", "decline", "cancel"]),
    }),
    event("task_complete", { stopReason: z.string(), usage: usage.optional() }),
    event("task_run_started", { startedAt: z.number().finite() }),
    event("task_warning", { warning: z.string() }),
    event("task_error", { error: z.string() }),
    event("config_option_update", { configOptions: z.array(configOption) }),
    event("available_commands_update", {
      commands: z.array(z.object({ name: z.string(), description: z.string() }).passthrough()),
    }),
    event("mode_update", {
      currentModeId: z.string(),
      availableModes: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()),
    }),
    event("session_info_update", {}),
    event("goal_verification_update", { verification: zcodeSessionGoalVerificationSchema }),
    event("task_token_usage_delta", { eventKey: identifier, usage }),
    event("task_network_debug_status", {
      eventKey: identifier,
      statusType: z.enum([
        "model_request_started",
        "model_request_completed",
        "model_request_failed",
        "model_retry_scheduled",
        "model_stream_stalled",
      ]),
      requestHeaders: z.record(z.string(), z.string()),
      responseHeaders: z.record(z.string(), z.string()),
      requestHeaderCount: z.number().int().nonnegative(),
      responseHeaderCount: z.number().int().nonnegative(),
    }),
    event("usage_update", { size: z.number().finite(), used: z.number().finite() }),
    event("background_bash_jobs_update", {
      jobs: z.array(
        z
          .object({
            jobId: identifier,
            command: z.string(),
            taskKind: z.enum(["agent", "bash"]),
            status: z.enum(["pending", "running", "completed", "failed", "killed", "lost"]),
          })
          .passthrough(),
      ),
    }),
  ]);
