import { describe, expect, it } from "vitest";
import { taskRealtimeEventSchema, taskStreamMirrorPublishOpSchema } from "./task-realtime-core.js";
import type { TaskStreamMirrorPublishOp } from "./task-realtime.js";
import type { TaskStreamMirrorableEvent } from "./zcode-task-types-core.js";

const base = { taskId: "test-task", traceId: "test-trace" };
const tokenUsage = { inputTokens: 1, outputTokens: 2, totalTokens: 3 };
const validEvents: TaskStreamMirrorableEvent[] = [
  { ...base, type: "agent_message_chunk", content: "message" },
  { ...base, type: "agent_thought_chunk", content: "thought" },
  { ...base, type: "tool_call", toolId: "tool", input: {}, kind: "read", title: "Read", raw: {} },
  { ...base, type: "tool_call_update", toolId: "tool", status: "completed", raw: {} },
  { ...base, type: "plan", steps: [{ id: "step", title: "Read", status: "in_progress" }] },
  {
    ...base,
    type: "permission_request",
    requestId: "request",
    description: "Read",
    kind: "read",
    options: [],
    raw: {},
  },
  {
    ...base,
    type: "permission_response",
    requestId: "request",
    optionId: "allow",
    response: { decision: "allow" },
  },
  { ...base, type: "elicitation_request", requestId: "request", message: "Choose", options: [] },
  { ...base, type: "elicitation_response", requestId: "request", action: "accept" },
  { ...base, type: "task_complete", stopReason: "end_turn", usage: tokenUsage },
  { ...base, type: "task_run_started", startedAt: 1 },
  { ...base, type: "task_warning", warning: "warning" },
  { ...base, type: "task_error", error: "error" },
  {
    ...base,
    type: "config_option_update",
    configOptions: [
      {
        id: "mode",
        name: "Mode",
        type: "select",
        currentValue: "build",
        options: [{ value: "build", name: "Build" }],
      },
    ],
  },
  { ...base, type: "available_commands_update", commands: [{ name: "help", description: "Help" }] },
  {
    ...base,
    type: "mode_update",
    currentModeId: "build",
    availableModes: [{ id: "build", name: "Build" }],
  },
  { ...base, type: "session_info_update", title: "Title", apiRetry: null },
  {
    ...base,
    type: "goal_verification_update",
    verification: { passed: true, reason: "Done", nextAction: null },
  },
  { ...base, type: "task_token_usage_delta", eventKey: "event", usage: tokenUsage },
  {
    ...base,
    type: "task_network_debug_status",
    eventKey: "event",
    statusType: "model_request_completed",
    requestHeaders: {},
    responseHeaders: {},
    requestHeaderCount: 0,
    responseHeaderCount: 0,
  },
  { ...base, type: "usage_update", size: 100, used: 3, cost: { amount: 0, currency: "USD" } },
  {
    ...base,
    type: "background_bash_jobs_update",
    jobs: [
      { jobId: "job", command: "test", taskKind: "bash", status: "running", stdoutTail: "output" },
    ],
  },
];

describe("task stream mirror event validation", () => {
  it.each(validEvents)("keeps the existing $type wire payload", (event) => {
    const input = { kind: "stream_event", event };
    expect(taskStreamMirrorPublishOpSchema.parse(input)).toEqual(input);
    const batch = {
      type: "task_stream_mirror_batch",
      eventId: "test-event",
      workspacePath: "/test-workspace",
      workspaceKey: "/test-workspace",
      ...base,
      runId: base.traceId,
      createdAt: 1,
      batchSeq: 1,
      fromSeq: 1,
      toSeq: 1,
      ops: [{ ...input, seq: 1 }],
      terminal: false,
    };
    expect(taskRealtimeEventSchema.parse(batch)).toEqual(batch);
  });
  it.each([
    { type: "agent_message_chunk" },
    { type: "agent_thought_chunk", content: 42 },
    { type: "tool_call_update", toolId: "test-tool", status: "invented", raw: {} },
    { type: "plan", steps: [{ id: "step", title: "test", status: "invented" }] },
    { type: "task_network_debug_status", eventKey: "event" },
    { type: "unknown_future_event" },
  ])("rejects a malformed $type before the bus consumes it", (event) => {
    expect(
      taskStreamMirrorPublishOpSchema.safeParse({
        kind: "stream_event",
        event: { ...base, ...event },
      }).success,
    ).toBe(false);
  });

  it("preserves valid chunk correlation and extension metadata", () => {
    const input: TaskStreamMirrorPublishOp = {
      kind: "stream_event",
      event: {
        ...base,
        type: "agent_message_chunk",
        content: "test chunk",
        inputId: "test-input",
        parentToolUseId: "test-parent-tool",
        messageId: "test-message",
      },
    };
    const parsed = taskStreamMirrorPublishOpSchema.parse({
      ...input,
      event: { ...input.event, extension: { version: 1 } },
    });
    if (parsed.kind !== "stream_event") throw new Error("Expected a stream event");
    expect(parsed.event).toMatchObject({ ...input.event, extension: { version: 1 } });
  });
});
