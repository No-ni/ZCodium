import { describe, expect, it, vi } from "vitest";
import {
  SessionEventType,
  type Model,
  type SessionEvent,
  type TraceContext,
  type TurnId,
  type ToolExecutionResult,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import {
  recordModelUsageFact,
  recordTurnUsageFact,
  recordToolUsageFromEvent,
} from "../src/runtime/methods/usage-observability.js";
import { recordToolUsageFromResult } from "../src/runtime/methods/turn-tool-usage.js";

const marker = "fixture-private-error-content";
const traceContext = {
  traceId: "fixture-trace",
  spanId: "fixture-span",
  sessionId: "fixture-session",
  turnId: "fixture-turn",
} as unknown as TraceContext;
const failures = [
  { name: "Error", value: new Error(marker) },
  { name: "string", value: marker },
  {
    name: "throwing toString",
    value: {
      toString() {
        throw new Error(marker);
      },
    },
  },
];

describe("用量写入故障只记录安全技术字段", () => {
  for (const kind of ["model", "turn", "tool", "tool_result"] as const) {
    it.each(failures)(`${kind}: $name 不泄漏或阻断主执行`, async ({ value }) => {
      const warn = vi.fn();
      const reject = vi.fn().mockRejectedValue(value);
      const runtime = {
        sessionId: "fixture-session",
        config: {},
        logger: { warn },
        registry: { get: () => undefined },
        sessionStore: {
          recordModelUsage: reject,
          upsertTurnUsage: reject,
          upsertToolUsage: reject,
        },
      } as unknown as AgentRuntimeInternal;
      const operation =
        kind === "model"
          ? recordModelUsageFact(runtime, {
              model: {
                providerId: "fixture-provider",
                modelId: "fixture-model",
                options: {},
              } as Model,
              events: [],
              networkEventStartIndex: 0,
              querySource: "main_turn",
              startedAt: 1000,
              status: "completed",
              traceContext,
            })
          : kind === "turn"
            ? recordTurnUsageFact(runtime, {
                events: [],
                startedAt: 1000,
                completedAt: 1100,
                status: "completed",
                turnId: "fixture-turn" as TurnId,
                traceContext,
              })
            : kind === "tool"
              ? recordToolUsageFromEvent(
                  runtime,
                  {
                    type: SessionEventType.ToolCallScheduled,
                    payload: { toolCallId: "fixture-tool", toolName: "Read" },
                    timestamp: new Date(1000),
                  } as SessionEvent,
                  traceContext,
                )
              : recordToolUsageFromResult(
                  runtime,
                  {
                    toolCallId: "fixture-tool",
                    toolName: "Read",
                    startedAt: new Date(1000),
                    completedAt: new Date(1100),
                    durationMs: 100,
                    success: true,
                    output: "",
                  } as ToolExecutionResult,
                  traceContext,
                );
      await expect(operation).resolves.toBeUndefined();
      expect(reject).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(marker);
      expect(warn.mock.calls[0]?.[1]).toMatchObject({
        event: `usage.${kind === "tool_result" ? "tool" : kind}.write.failed`,
        status: "failed",
      });
    });
  }
});
