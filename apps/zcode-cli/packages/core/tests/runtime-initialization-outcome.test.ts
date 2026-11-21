import { describe, expect, it, vi } from "vitest";
import {
  createSessionEvent,
  createSessionId,
  SessionEventType,
  type SessionStorePort,
} from "@zcode/contracts";
import { createRootTraceContext } from "@zcode/contracts";
import { appendEvent } from "../src/runtime/methods/events.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";

function fixture(persisted: boolean) {
  const sessionId = createSessionId("fixture-outcome");
  const eventStore = createTestSessionEventStore();
  const updateSession = vi.fn(async () => undefined);
  const sessionStore = { updateSession } as unknown as SessionStorePort;
  const runtime = createTestAgentRuntime(
    sessionId,
    { mode: "build" },
    { sessionStore, eventStore },
  );
  const internal = runtime as unknown as AgentRuntimeInternal;
  // 模拟原创建/恢复 owner 的已完成状态；不伪造数据库写入或另一条持久化路径。
  internal.sessionPersisted = persisted;
  const notify = vi.spyOn(internal, "notifyEventSinks");
  const trace = createRootTraceContext({ sessionId });
  return { runtime, internal, sessionId, eventStore, updateSession, notify, trace };
}

describe("会话初始化与终态持久化边界", () => {
  it("创建前的错误事件可发布，不更新不存在的会话", async () => {
    const f = fixture(false);
    f.updateSession.mockRejectedValue(new Error("fixture missing session"));
    const event = createSessionEvent(SessionEventType.TurnError, f.sessionId, {
      error: "fixture initialization failure",
    });
    await expect(appendEvent.call(f.internal, event, f.trace)).resolves.toBeUndefined();
    expect(f.updateSession).not.toHaveBeenCalled();
    expect(f.notify).toHaveBeenCalledOnce();
    expect(f.notify.mock.calls[0][0]).toMatchObject({
      type: SessionEventType.TurnError,
      sequenceNumber: 1,
      payload: event.payload,
    });
  });

  it.each([
    { type: SessionEventType.TurnError, payload: {}, outcome: "error" },
    {
      type: SessionEventType.TurnComplete,
      payload: { resultType: "cancelled" },
      outcome: "interrupted",
    },
    {
      type: SessionEventType.TurnComplete,
      payload: { resultType: "completed" },
      outcome: "completed",
    },
  ])("已持久会话保留 $outcome 终态", async ({ type, payload, outcome }) => {
    const f = fixture(true);
    await appendEvent.call(f.internal, createSessionEvent(type, f.sessionId, payload), f.trace);
    expect(f.updateSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: f.sessionId, lastOutcome: outcome }),
    );
    expect(f.notify).toHaveBeenCalledOnce();
  });

  it("真实终态写失败仍拒绝，不能把保护扩大为忽略所有错误", async () => {
    const f = fixture(true),
      error = new Error("fixture storage failure");
    f.updateSession.mockRejectedValue(error);
    await expect(
      appendEvent.call(
        f.internal,
        createSessionEvent(SessionEventType.TurnError, f.sessionId, {}),
        f.trace,
      ),
    ).rejects.toBe(error);
    expect(f.notify).not.toHaveBeenCalled();
  });
});
