import { it, expect, afterEach } from "vitest";
import { LocalTtftRecorder } from "../src/zcode-protocol-v4/local-ttft/contract.js";
import { createSessionEvent, SessionEventType, type SessionEvent, type SessionId, type TurnId } from "@zcode/contracts";
// CLI 测试入口只扫描 tests/；在这里执行模块公共合同用例。
import "../src/zcode-protocol-v4/local-ttft/contract.test.js";

const recorders: LocalTtftRecorder[] = [];
// 计时旁路跟随现存业务事件，不重新接入已退役的 telemetry fact 归一化接口。
function businessEvent(recorder: LocalTtftRecorder, sessionId: string, turnId: string, type: SessionEvent["type"], payload: unknown) {
  recorder.event(sessionId, createSessionEvent(type, sessionId as SessionId, payload, { turnId: turnId as TurnId }));
}
function modelEvent(recorder: LocalTtftRecorder, payload: unknown, sessionId = "session", turnId = "turn") {
  businessEvent(recorder, sessionId, turnId, SessionEventType.ModelNetworkStatus, payload);
}
function createRecorder(...args: ConstructorParameters<typeof LocalTtftRecorder>) {
  const recorder = new LocalTtftRecorder(...args);
  recorders.push(recorder);
  return recorder;
}
afterEach(() => {
  for (const recorder of recorders) recorder.clear();
  recorders.length = 0;
});

it("本地诊断在 admission 等待前保留收到命令的检查点", () => {
  const facts: unknown[] = [];
  const recorder = createRecorder(
    () => 100,
    undefined,
    (fact) => facts.push(fact),
  );
  recorder.receive(
    {
      commandId: "input",
      clientId: "client",
      sessionId: "session",
      type: "sendText",
      payload: {},
      issuedAt: 90,
      ttft: { version: 1, observationId: "e0b15fc2-3a50-4d73-854d-61fa148cbfd0", localOnly: true },
    },
    false,
  );
  expect(facts).toEqual([
    expect.objectContaining({
      commandId: "input",
      receivedAt: 100,
      localOnly: true,
    }),
  ]);
  expect(facts[0]).not.toHaveProperty("admittedAt");
});

it("执行边界沿 TurnStarted 携带原始时钟，前置 hooks 不得算排队", () => {
  let now = 100;
  const recorder = createRecorder(() => now);
  recorder.receive(
    {
      commandId: "input",
      clientId: "client",
      sessionId: "session",
      type: "sendText",
      payload: {},
      issuedAt: 100,
      ttft: { version: 1, observationId: "e0b15fc2-3a50-4d73-854d-61fa148cbfd0" },
    },
    false,
  );
  now = 110;
  recorder.admitted("input");
  now = 250;
  businessEvent(recorder, "session", "turn", SessionEventType.TurnStarted, { inputId: "input", executionStartedAt: 120 });
  expect(recorder.forSession("session")?.executionAt).toBe(120);
});

it("不可重试的最终失败不伪装成发生了重试", () => {
  const recorder = createRecorder(() => 100);
  recorder.receive(
    {
      commandId: "input",
      clientId: "client",
      sessionId: "session",
      type: "sendText",
      payload: {},
      issuedAt: 100,
      ttft: { version: 1, observationId: "e0b15fc2-3a50-4d73-854d-61fa148cbfd0" },
    },
    false,
  );
  const base = {
    version: 1 as const,
    eventId: "event",
    eventSeq: 1,
    occurredAt: 100,
    sessionId: "session",
    sourceCommandId: "input",
    turnId: "turn",
  };
  businessEvent(recorder, "session", "turn", SessionEventType.TurnStarted, { inputId: "input", executionStartedAt: 100 });
  const request = {
    ...base,
    querySource: "main_turn",
    requestId: "req",
    providerId: "p",
    modelId: "m",
    transport: "sse",
    attempt: 1,
    maxAttempts: 1,
  };
  modelEvent(recorder, { ...request, type: "model_request_started" });
  modelEvent(recorder, {
    ...request,
    type: "model_request_failed",
    retryable: false,
    reason: "unauthorized",
  });
  expect(recorder.forSession("session")?.excluded).toBeUndefined();
  recorder.output("session", "turn", "text");
  expect(recorder.forSession("session")?.outputAt).toBeUndefined();
  businessEvent(recorder, "session", "turn", SessionEventType.TurnError, { inputId: "input", error: { type: "unauthorized", message: "fixed fixture error" } });
  expect(recorder.forSession("session")?.terminal).toBe("failed");
});

it("排队不会抢占执行中输入，重试 attempt 延续原起点并接受第二次输出", () => {
  let now = 100;
  const recorder = createRecorder(() => now);
  const envelope = (id: string) => ({
    commandId: id,
    clientId: "client",
    sessionId: "session",
    type: "sendText" as const,
    payload: {},
    issuedAt: now,
    ttft: { version: 1 as const, observationId: "e0b15fc2-3a50-4d73-854d-61fa148cbfd0" },
  });
  recorder.receive(envelope("input"), false);
  recorder.admitted("input");
  const base = {
    version: 1 as const,
    eventId: "start",
    eventSeq: 1,
    occurredAt: now,
    sessionId: "session",
    sourceCommandId: "input",
    turnId: "turn",
  };
  businessEvent(recorder, "session", "turn", SessionEventType.TurnStarted, { inputId: "input", executionStartedAt: 110 });
  recorder.receive(envelope("queued"), true);
  expect(recorder.forSession("session")?.commandId).toBe("input");
  const request = {
    ...base,
    querySource: "main_turn",
    requestId: "req1",
    providerId: "p",
    modelId: "m",
    transport: "sse",
    attempt: 1,
    maxAttempts: 2,
  };
  now = 120;
  modelEvent(recorder, { ...request, type: "model_request_started" });
  now = 150;
  modelEvent(recorder, {
    ...request,
    type: "model_request_failed",
    reason: "rate_limit",
    retryable: true,
  });
  modelEvent(recorder, {
    ...request,
    type: "model_retry_scheduled",
    delayMs: 50,
    nextAttempt: 2,
    reason: "rate_limit",
  });
  now = 200;
  modelEvent(recorder, { ...request, requestId: "req2", attempt: 2, type: "model_request_started" });
  now = 250;
  recorder.output("session", "turn", "text");
  expect(recorder.forSession("session")).toMatchObject({
    commandId: "input",
    requestAt: 120,
    outputAt: 250,
  });
  expect(recorder.forSession("session")?.excluded).toBeUndefined();
  expect(
    recorder.forSession("session")?.details?.filter((detail) => detail.stage === "attempt"),
  ).toMatchObject([
    { requestId: "req1", start: 120, end: 150, outcome: "failed" },
    { requestId: "req2", start: 200, end: 250, outcome: "first_output" },
  ]);
});

it("准备阶段订阅只观察原输入，重复阶段保留独立区间且结束后解除订阅", async () => {
  const { beginLocalTurnPreparation } = await import("@zcode/contracts");
  const recorder = createRecorder();
  recorder.receive(
    {
      commandId: "prep-input",
      clientId: "c",
      sessionId: "s",
      type: "sendText",
      payload: {},
      issuedAt: 0,
      ttft: { version: 1, observationId: "e0b15fc2-3a50-4d73-854d-61fa148cbfd0" },
    },
    false,
  );
  const trace = { queryId: "prep-input", sessionId: "s", turnId: "t" };
  const context = beginLocalTurnPreparation(trace, "context");
  const hooks = beginLocalTurnPreparation(trace, "hooks");
  hooks();
  context();
  beginLocalTurnPreparation({ ...trace, queryId: "other-input" }, "hooks")();
  const facts = recorder.forSession("s");
  expect(facts?.details?.map((item) => item.stage)).toEqual(["context", "hooks"]);
  expect(facts?.details?.every((item) => item.end !== undefined)).toBe(true);
  expect(new Set(facts?.details?.map((item) => item.id)).size).toBe(2);
  recorder.clear();
  expect(() => beginLocalTurnPreparation(trace, "hooks")()).not.toThrow();
});

it("立即引导独立分类，压缩模型不抢记用户输出", async () => {
  const { SessionEventType, createSessionEvent, createSessionId, createTurnId } =
    await import("@zcode/contracts");
  const sessionId = createSessionId();
  const turnId = createTurnId();
  const recorder = createRecorder(() => 100);
  const envelope = (commandId: string) => ({
    commandId,
    clientId: "c",
    sessionId,
    type: "sendText" as const,
    payload: {},
    issuedAt: 0,
    ttft: { version: 1 as const, observationId: "e0b15fc2-3a50-4d73-854d-61fa148cbfd0" },
  });
  recorder.receive(envelope("main"), false);
  const base = {
    version: 1 as const,
    eventId: "e",
    eventSeq: 1,
    occurredAt: 100,
    sessionId,
    turnId,
    sourceCommandId: "main",
  };
  businessEvent(recorder, sessionId, turnId, SessionEventType.TurnStarted, { inputId: "main", executionStartedAt: 100 });
  const request = {
    ...base,
    requestId: "req",
    providerId: "p",
    modelId: "m",
    transport: "sse",
    attempt: 1,
    maxAttempts: 2,
  };
  modelEvent(recorder, { ...request, querySource: "main_turn", type: "model_request_started" }, sessionId, turnId);
  modelEvent(recorder, {
    ...request,
    requestId: "compact",
    querySource: "compact",
    type: "model_request_started",
  }, sessionId, turnId);
  recorder.output(sessionId, turnId, "text");
  expect(recorder.forSession(sessionId)?.outputAt).toBeUndefined();
  recorder.receive(envelope("guide"), true);
  recorder.event(
    sessionId,
    createSessionEvent(
      SessionEventType.TurnSteerQueued,
      sessionId,
      { inputId: "guide", pendingInputId: "queue_guide", delivery: "guide" },
      { turnId },
    ),
  );
  recorder.event(
    sessionId,
    createSessionEvent(
      SessionEventType.TurnSteerDrained,
      sessionId,
      {
        pendingInputIds: ["queue_guide"],
        drainedInputs: [{ pendingInputId: "queue_guide", delivery: "guide" }],
      },
      { turnId },
    ),
  );
  expect(recorder.forSession(sessionId, "guide")?.sendMode).toBe("guided");
  expect(recorder.forSession(sessionId, "guide")?.outputAt).toBeUndefined();
  recorder.clear();
});

it("细分预算满仍记录主请求与输出，并明确标记截断", async () => {
  const { beginLocalTurnPreparation } = await import("@zcode/contracts");
  const recorder = createRecorder();
  recorder.receive(
    {
      commandId: "bounded",
      clientId: "c",
      sessionId: "s",
      type: "sendText",
      payload: {},
      issuedAt: Date.now(),
      ttft: { version: 1, observationId: "e0b15fc2-3a50-4d73-854d-61fa148cbfd0" },
    },
    false,
  );
  for (let i = 0; i < 70; i++)
    beginLocalTurnPreparation({ queryId: "bounded", sessionId: "s", turnId: "t" }, "hooks")();
  modelEvent(recorder, {
    version: 1,
    eventId: "model",
    eventSeq: 1,
    occurredAt: Date.now(),
    sessionId: "s",
    sourceCommandId: "bounded",
    turnId: "t",
    querySource: "main_turn",
    requestId: "request",
    providerId: "p",
    modelId: "m",
    transport: "sse",
    attempt: 1,
    maxAttempts: 1,
    type: "model_request_started",
  }, "s", "t");
  recorder.output("s", "t", "text");
  expect(recorder.forSession("s")?.details).toHaveLength(64);
  expect(recorder.forSession("s")).toMatchObject({ truncated: true, outputKind: "text" });
  expect(recorder.forSession("s")?.outputAt).toBeDefined();
});
