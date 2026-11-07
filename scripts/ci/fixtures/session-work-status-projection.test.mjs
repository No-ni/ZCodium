import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as settled } from "node:timers/promises";
import { SessionEventType } from "../../../apps/zcode-cli/packages/contracts/src/index.ts";
import { Emitter } from "../../../packages/rpc/src/index.ts";
import {
  V4_WIRE_PROTOCOL_VERSION,
  conversationSnapshotSchema,
  sessionSummarySchema,
  sessionsIndexTopic,
} from "../../../packages/shared/src/zcode-protocol-v4/index.ts";
import { ProductProjection } from "../../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts";
import {
  SessionsIndexProjection,
  deriveSessionSummary,
} from "../../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/sessions-index-projection.ts";
import { createZCodeTaskIndexSyncer } from "../../../packages/services/src/zcode-agent/zcodeTaskIndexSyncer.ts";
import { synthesizeEventsFromMessages } from "../../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/transcript-hydration.ts";

const BASE = 1_700_000_000_000;
const extra = { workspaceId: "workspace-fixture", createdAt: BASE, lastActivityAt: BASE + 20_000 };

function runtimeFixture() {
  const events = [];
  const projection = new ProductProjection("session-fixture", "epoch-fixture");
  const apply = (type, payload, offset, turnId = "turn-fixture") => {
    const event = {
      id: `event-${events.length + 1}`,
      sessionId: "session-fixture",
      turnId,
      type,
      payload,
      timestamp: new Date(BASE + offset),
      sequenceNumber: events.length + 1,
      traceId: "trace-fixture",
    };
    events.push(event);
    projection.applyEvent(event);
    return event;
  };
  apply(
    SessionEventType.TurnStarted,
    { turnNumber: 1, input: "fixture", messageId: "user-fixture" },
    0,
  );
  return { projection, events, apply };
}

function queueSnapshot(dispatchState, autoDrain = true) {
  const snapshot = runtimeFixture().projection.getSnapshot();
  return {
    ...snapshot,
    control: { ...snapshot.control, phase: "completedSuccess", sessionEnded: true },
    // 派生函数只读 queue 长度，不消费输入文本；三个状态覆盖提升的整个交接窗口。
    queue: { autoDrain, items: [Object.freeze({ dispatch: { state: dispatchState } })] },
  };
}

for (const state of ["queued", "reserved", "promoting"]) {
  test(`自动队列 ${state} 保留完成 phase，但抑制成功提醒资格`, () => {
    const snapshot = queueSnapshot(state);
    const summary = deriveSessionSummary(snapshot, extra);
    assert.equal(summary.autoContinuePending, true);
    assert.equal(summary.phase, "completedSuccess");
    assert.equal(summary.sessionEnded, true);
    assert.equal(sessionSummarySchema.parse(summary).autoContinuePending, true);
    assert.equal(snapshot.queue.items.length, 1);
  });
}

test("held queue 与空队列不阻止已经结束的工作提醒", () => {
  const held = queueSnapshot("queued", false);
  assert.equal(deriveSessionSummary(held, extra).autoContinuePending ?? false, false);
  assert.equal(
    deriveSessionSummary({ ...held, queue: { autoDrain: true, items: [] } }, extra)
      .autoContinuePending ?? false,
    false,
  );
});

test("旧摘要缺字段兼容，新字段必须是真实 boolean", () => {
  const legacy = {
    sessionId: "legacy",
    workspaceId: "workspace-fixture",
    title: "legacy",
    phase: "completedSuccess",
    sessionEnded: true,
    hasBackgroundWork: false,
    createdAt: BASE,
    lastActivityAt: BASE,
  };
  assert.equal(sessionSummarySchema.parse(legacy).autoContinuePending ?? false, false);
  assert.equal(
    sessionSummarySchema.parse({ ...legacy, autoContinuePending: true }).autoContinuePending,
    true,
  );
  assert.equal(
    sessionSummarySchema.safeParse({ ...legacy, autoContinuePending: "true" }).success,
    false,
  );
});

test("仅队列资格变化也发布摘要；清空最终队列后 same phase 发布一次", () => {
  const index = new SessionsIndexProjection("workspace-fixture", "list-epoch");
  const snapshot = queueSnapshot("queued");
  const meta = { createdAt: BASE, lastActivityAt: BASE + 20_000 };
  assert.equal(index.upsertFromConversation(snapshot, meta).length, 1);
  const empty = { ...snapshot, queue: { autoDrain: true, items: [] } };
  const final = index.upsertFromConversation(empty, meta);
  assert.equal(final.length, 1);
  assert.equal(final[0].session.phase, "completedSuccess");
  assert.equal(final[0].session.autoContinuePending ?? false, false);
  assert.equal(index.upsertFromConversation(empty, meta).length, 0);
  // 旧冷种子无字段，与新投影 false 等价，不因兼容值制造列表刷新。
  const legacy = deriveSessionSummary(empty, { workspaceId: "workspace-fixture", ...meta });
  delete legacy.autoContinuePending;
  index.seed(legacy);
  assert.equal(index.upsertFromConversation(empty, meta).length, 0);
});

function promotionFixture(kind) {
  const f = runtimeFixture();
  f.apply(SessionEventType.QueueAutoDrainChanged, { autoDrain: true }, 500);
  f.apply(
    SessionEventType.TurnSteerQueued,
    {
      pendingInputId: "queue-fixture",
      input: "fixture",
      inputPreview: "fixture",
      inputSize: 7,
      queueLength: 1,
      targetTurnId: "turn-fixture",
      intent: {
        sourceCommandId: "queue-command",
        queueItemId: "queue-fixture",
        clientId: "fixture-client",
        kind,
        admissionSeq: 1,
        admittedAt: BASE + 600,
        requestedDelivery: "queue",
        admittedDelivery: "queue",
        attachmentRefs: [],
      },
    },
    600,
  );
  f.apply(
    SessionEventType.TurnSteerDispatchChanged,
    {
      pendingInputId: "queue-fixture",
      reservationId: "reservation-fixture",
      state: "promoting",
      targetTurnId: "turn-fixture",
    },
    700,
  );
  f.apply(
    SessionEventType.TurnComplete,
    { response: "", tokenCount: 0, toolCallCount: 0, duration: 1000, resultType: "success" },
    1000,
  );
  return f;
}

for (const kind of ["sendText", "compact"]) {
  for (const discardFirst of [true, false]) {
    test(`${kind} 真实投影 ${discardFirst ? "admission先移除" : "TurnStarted先到"} 顺序无成功空队列窗口`, () => {
      const f = promotionFixture(kind);
      const states = [deriveSessionSummary(f.projection.getSnapshot(), extra)];
      const discard = () =>
        f.apply(
          SessionEventType.TurnSteerDiscarded,
          { pendingInputIds: ["queue-fixture"], reason: "promoted", targetTurnId: "turn-fixture" },
          1100,
        );
      const start = () =>
        f.apply(
          SessionEventType.TurnStarted,
          {
            turnNumber: 2,
            input: kind === "compact" ? "/compact" : "fixture",
            inputId: "queue-command",
            ...(kind === "compact" ? { inputVisibility: "model-only" } : {}),
          },
          1200,
          "turn-next",
        );
      if (discardFirst) {
        discard();
        states.push(deriveSessionSummary(f.projection.getSnapshot(), extra));
        assert.equal(f.projection.getSnapshot().queue.items.length, 1);
        start();
      } else {
        start();
        states.push(deriveSessionSummary(f.projection.getSnapshot(), extra));
        discard();
      }
      states.push(deriveSessionSummary(f.projection.getSnapshot(), extra));
      assert.equal(f.projection.getSnapshot().queue.items.length, 0);
      assert.equal(
        states.some(
          (state) => state.phase === "completedSuccess" && state.autoContinuePending !== true,
        ),
        false,
      );
      f.apply(
        SessionEventType.TurnComplete,
        { response: "", tokenCount: 0, toolCallCount: 0, duration: 2000, resultType: "success" },
        3200,
        "turn-next",
      );
      const final = deriveSessionSummary(f.projection.getSnapshot(), extra);
      assert.equal(final.phase, "completedSuccess");
      assert.equal(final.autoContinuePending, false);
    });
  }
  test(`${kind} 快轮已结束才到 promoted discard，不留下 promoting 幽灵项`, () => {
    const f = promotionFixture(kind);
    f.apply(
      SessionEventType.TurnStarted,
      { turnNumber: 2, input: "fixture", inputId: "queue-command" },
      1200,
      "turn-next",
    );
    f.apply(
      SessionEventType.TurnComplete,
      { response: "", tokenCount: 0, toolCallCount: 0, duration: 0, resultType: "success" },
      1200,
      "turn-next",
    );
    f.apply(
      SessionEventType.TurnSteerDiscarded,
      { pendingInputIds: ["queue-fixture"], reason: "promoted", targetTurnId: "turn-fixture" },
      1300,
    );
    assert.equal(f.projection.getSnapshot().queue.items.length, 0);
    assert.equal(
      deriveSessionSummary(f.projection.getSnapshot(), extra).autoContinuePending,
      false,
    );
  });
}

test("真实 queue 用户删除和失败丢弃立即清除；旧终态durable不能替代执行开始", () => {
  for (const reason of ["user_removed", "turn_failed", "promoted"]) {
    const f = promotionFixture("sendText");
    f.apply(
      SessionEventType.TurnSteerDiscarded,
      { pendingInputIds: ["queue-fixture"], reason, targetTurnId: "turn-fixture" },
      1100,
    );
    assert.equal(f.projection.getSnapshot().queue.items.length, reason === "promoted" ? 1 : 0);
    f.apply(
      SessionEventType.SessionInputPromoted,
      {
        pendingInputId: "queue-fixture",
        sourceCommandId: "queue-command",
        messageId: "message-next",
      },
      1200,
      "turn-next",
    );
    assert.equal(f.projection.getSnapshot().queue.items.length, reason === "promoted" ? 1 : 0);
    f.apply(
      SessionEventType.TurnStarted,
      { turnNumber: 2, input: "fixture", inputId: "queue-command" },
      1300,
      "turn-next",
    );
    assert.equal(f.projection.getSnapshot().queue.items.length, 0);
  }
});

const goalTarget = {
  targetID: "target-fixture",
  objective: "fixture",
  status: "active",
  timeUsedSeconds: 0,
};
for (const previousStatus of [undefined, "complete"]) {
  test(`Goal真实控制事件先durable、controlOnly，后active；旧${previousStatus ?? "无Goal"}不提前完成`, () => {
    const f = promotionFixture("sendGoalCommand");
    if (previousStatus)
      f.apply(
        SessionEventType.TargetChanged,
        { action: "set", source: "command", target: { ...goalTarget, status: previousStatus } },
        1050,
      );
    const states = [deriveSessionSummary(f.projection.getSnapshot(), extra)];
    f.apply(
      SessionEventType.SessionInputPromoted,
      {
        pendingInputId: "queue-fixture",
        sourceCommandId: "queue-command",
        messageId: "goal-query",
      },
      1100,
      "control-turn",
    );
    states.push(deriveSessionSummary(f.projection.getSnapshot(), extra));
    assert.equal(f.projection.getSnapshot().queue.items.length, 1);
    f.apply(
      SessionEventType.TurnStarted,
      {
        turnNumber: 2,
        input: "/goal fixture",
        inputId: "queue-command",
        messageId: "goal-query",
        executionKind: "controlOnly",
      },
      1200,
      "control-turn",
    );
    f.apply(
      SessionEventType.TurnComplete,
      { response: "", tokenCount: 0, toolCallCount: 0, duration: 0, resultType: "success" },
      1300,
      "control-turn",
    );
    states.push(deriveSessionSummary(f.projection.getSnapshot(), extra));
    assert.equal(f.projection.getSnapshot().queue.items.length, 1);
    f.apply(
      SessionEventType.TargetChanged,
      { action: "set", source: "command", target: goalTarget },
      1400,
    );
    states.push(deriveSessionSummary(f.projection.getSnapshot(), extra));
    assert.equal(f.projection.getSnapshot().queue.items.length, 0);
    assert.equal(
      states.some(
        (state) =>
          state.phase === "completedSuccess" &&
          state.autoContinuePending !== true &&
          (state.goalStatus === undefined || state.goalStatus === "verified"),
      ),
      false,
    );
    // 后续候选被暂停/缺失、没有 agent continuation 时，原队列也已准确收口。
    f.apply(
      SessionEventType.TargetChanged,
      { action: "status_updated", source: "command", target: { ...goalTarget, status: "paused" } },
      1500,
    );
    assert.equal(f.projection.getSnapshot().queue.items.length, 0);
  });
}

test("无同源控制query的外部target变化不清Goal promoting，reservation回滚后明确删除收敛", () => {
  const f = promotionFixture("sendGoalCommand");
  f.apply(
    SessionEventType.TurnStarted,
    { turnNumber: 2, input: "foreign", inputId: "foreign-command", executionKind: "controlOnly" },
    1100,
    "control-turn",
  );
  f.apply(
    SessionEventType.TargetChanged,
    { action: "set", source: "command", target: goalTarget },
    1200,
  );
  assert.equal(f.projection.getSnapshot().queue.items.length, 1);
  f.apply(
    SessionEventType.TurnSteerDispatchChanged,
    { pendingInputId: "queue-fixture", state: "queued", targetTurnId: "turn-fixture" },
    1300,
  );
  assert.equal(f.projection.getSnapshot().queue.items[0].dispatch.state, "queued");
  f.apply(
    SessionEventType.TurnSteerDiscarded,
    { pendingInputIds: ["queue-fixture"], reason: "user_removed", targetTurnId: "turn-fixture" },
    1400,
  );
  assert.equal(f.projection.getSnapshot().queue.items.length, 0);
});

for (const kind of ["sendText", "compact"]) {
  test(`${kind} 同源pre-start TurnError结算promoting，其余future输入held且foreign错误不误删`, () => {
    for (const inputId of ["queue-command", "foreign-command", undefined]) {
      const f = promotionFixture(kind);
      f.apply(
        SessionEventType.TurnSteerQueued,
        {
          pendingInputId: "future-fixture",
          input: "future",
          inputPreview: "future",
          inputSize: 6,
          queueLength: 2,
          targetTurnId: "turn-fixture",
        },
        1050,
      );
      f.apply(
        SessionEventType.TurnSteerDiscarded,
        { pendingInputIds: ["queue-fixture"], reason: "promoted", targetTurnId: "turn-fixture" },
        1100,
      );
      f.apply(
        SessionEventType.TurnError,
        {
          inputId,
          error: {
            type: "execution",
            code: "fixture.prestart",
            message: "fixture",
            retryable: false,
          },
          turnPhase: "before_start",
        },
        1200,
        "failed-turn",
      );
      const queue = f.projection.getSnapshot().queue;
      assert.equal(
        queue.items.some((item) => item.queueItemId === "queue-fixture"),
        inputId !== "queue-command",
      );
      assert.equal(
        queue.items.some((item) => item.queueItemId === "future-fixture"),
        true,
      );
      assert.equal(queue.autoDrain, false);
      assert.equal(queue.pauseReason, "error");
    }
  });
}

for (const kind of ["sendText", "compact"]) {
  test(`${kind} 同源pre-start取消清promoting，foreign取消不误删且future held`, () => {
    for (const inputId of ["queue-command", "foreign-command", undefined]) {
      const f = promotionFixture(kind);
      f.apply(
        SessionEventType.TurnSteerQueued,
        {
          pendingInputId: "future-fixture",
          input: "future",
          inputPreview: "future",
          inputSize: 6,
          queueLength: 2,
          targetTurnId: "turn-fixture",
        },
        1050,
      );
      f.apply(
        SessionEventType.TurnSteerDiscarded,
        {
          pendingInputIds: ["queue-fixture"],
          reason: "promoted",
          targetTurnId: "turn-fixture",
        },
        1100,
      );
      f.apply(
        SessionEventType.TurnComplete,
        {
          inputId,
          response: "",
          tokenCount: 0,
          toolCallCount: 0,
          duration: 0,
          resultType: "cancelled",
        },
        1200,
        "cancelled-turn",
      );
      const snapshot = f.projection.getSnapshot();
      assert.equal(
        snapshot.queue.items.some((item) => item.queueItemId === "queue-fixture"),
        inputId !== "queue-command",
      );
      assert.equal(
        snapshot.queue.items.some((item) => item.queueItemId === "future-fixture"),
        true,
      );
      assert.equal(snapshot.queue.autoDrain, false);
      assert.equal(snapshot.queue.pauseReason, "stopped");
      assert.equal(snapshot.control.phase, "completedInterrupted");
    }
  });
}

test("已running内durable仍清准确项，不因新延后契约留幽灵queue", () => {
  const f = promotionFixture("sendText");
  f.apply(
    SessionEventType.TurnStarted,
    { turnNumber: 2, input: "foreign", inputId: "foreign-command" },
    1100,
    "turn-next",
  );
  assert.equal(f.projection.getSnapshot().queue.items.length, 1);
  f.apply(
    SessionEventType.SessionInputPromoted,
    {
      pendingInputId: "queue-fixture",
      sourceCommandId: "queue-command",
      messageId: "message-next",
    },
    1200,
    "turn-next",
  );
  assert.equal(f.projection.getSnapshot().queue.items.length, 0);
});

const closers = [
  [
    "reasoning_end",
    SessionEventType.ModelStreaming,
    { kind: "reasoning_end", delta: "", done: false },
    "complete",
  ],
  [
    "成功轮终态",
    SessionEventType.TurnComplete,
    { response: "", tokenCount: 0, toolCallCount: 0, duration: 9000, resultType: "success" },
    "complete",
  ],
  [
    "错误轮终态",
    SessionEventType.TurnError,
    {
      error: { type: "execution", code: "fixture.error", message: "fixture", retryable: false },
      turnPhase: "model",
    },
    "interrupted",
  ],
  [
    "丢弃断流尾巴",
    SessionEventType.StreamRecoveryTailDiscarded,
    {
      attemptId: "attempt-fixture",
      anchorId: "anchor-fixture",
      assistantMessageId: "assistant-fixture",
      discardedReasoningBytes: 3,
      discardedTextBytes: 0,
      discardedToolCallIds: [],
    },
    "interrupted",
  ],
  [
    "模型回退",
    SessionEventType.TurnExecutionModelFallback,
    {
      inputId: "input-fixture",
      reason: "highspeed_request_failed",
      fromModelSelection: { providerId: "fixture-old", modelId: "model" },
      toModelSelection: { providerId: "fixture-new", modelId: "model" },
    },
    "interrupted",
  ],
  [
    "开启下一段思考",
    SessionEventType.ModelStreaming,
    {
      kind: "reasoning_start",
      delta: "",
      done: false,
      assistantMessageId: "assistant-next",
      partId: "reasoning-next",
    },
    "complete",
  ],
];

for (const [label, type, payload, state] of closers) {
  test(`${label} 用关闭事件时间冻结思考时长，事件 replay 保持同值`, () => {
    const f = runtimeFixture();
    f.apply(
      SessionEventType.ModelStreaming,
      {
        kind: "reasoning_start",
        delta: "",
        done: false,
        assistantMessageId: "assistant-fixture",
        partId: "reasoning-fixture",
      },
      1000,
    );
    f.apply(
      SessionEventType.ModelStreaming,
      { kind: "reasoning_delta", delta: "fixture", done: false },
      2000,
    );
    const live = f.projection.getSnapshot().rows.window.find((row) => row.kind === "reasoning");
    assert.equal(live.createdAt, BASE + 1000);
    assert.equal(live.durationMs, undefined);
    f.apply(type, payload, 7000);
    const row = f.projection.getSnapshot().rows.window.find((item) => item.rowId === live.rowId);
    assert.equal(row.state, state);
    assert.equal(row.durationMs, 6000);
    assert.equal(
      conversationSnapshotSchema
        .parse(f.projection.getSnapshot())
        .rows.window.find((item) => item.rowId === row.rowId).durationMs,
      6000,
    );
    const replay = new ProductProjection("session-fixture", "replay-epoch");
    for (const event of f.events) replay.applyEvent(event);
    assert.equal(
      replay.getSnapshot().rows.window.find((item) => item.rowId === row.rowId).durationMs,
      6000,
    );
    assert.equal(live.state, "streaming");
  });
}

test("思考关闭时间倒退钳制为零，完成后迟到流不修改固定时长", () => {
  const f = runtimeFixture();
  f.apply(
    SessionEventType.ModelStreaming,
    { kind: "reasoning_start", delta: "", done: false },
    7000,
  );
  f.apply(SessionEventType.ModelStreaming, { kind: "reasoning_end", delta: "", done: false }, 6000);
  f.apply(
    SessionEventType.TurnComplete,
    { response: "", tokenCount: 0, toolCallCount: 0, duration: 9000, resultType: "success" },
    9000,
  );
  f.apply(
    SessionEventType.ModelStreaming,
    { kind: "reasoning_end", delta: "", done: false },
    90_000,
  );
  assert.equal(
    f.projection.getSnapshot().rows.window.find((row) => row.kind === "reasoning").durationMs,
    0,
  );
});

for (const [label, time, expected] of [
  ["完整持久区间", { start: BASE + 1000, end: BASE + 7000 }, 6000],
  ["结束时间倒退", { start: BASE + 7000, end: BASE + 1000 }, 0],
  ["缺结束时间保留区间下界", { start: BASE + 1000 }, 0],
]) {
  test(`冷 transcript 思考${label}，不以合成 seq 估算历史工时`, () => {
    const messages = [
      {
        info: {
          id: "user-fixture",
          sessionID: "session-fixture",
          role: "user",
          time: { created: BASE },
          agent: "default",
          modelSelection: { providerId: "fixture", modelId: "model" },
        },
        parts: [
          {
            id: "input-fixture",
            sessionID: "session-fixture",
            messageID: "user-fixture",
            type: "text",
            text: "fixture",
          },
        ],
      },
      {
        info: {
          id: "assistant-fixture",
          sessionID: "session-fixture",
          role: "assistant",
          time: { created: BASE + 500, completed: BASE + 9000 },
          parentID: "user-fixture",
          modelId: "model",
          providerId: "fixture",
          mode: "default",
          agent: "default",
          path: { cwd: "workspace-fixture", root: "workspace-fixture" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [
          {
            id: "reasoning-fixture",
            sessionID: "session-fixture",
            messageID: "assistant-fixture",
            type: "reasoning",
            text: "fixture",
            time,
          },
        ],
      },
    ];
    const events = synthesizeEventsFromMessages(messages, {
      sessionId: "session-fixture",
      baseTimestampMs: BASE + 50_000,
    });
    const start = events.find((event) => event.payload.kind === "reasoning_start");
    const end = events.find((event) => event.payload.kind === "reasoning_end");
    assert.equal(start.timestamp.getTime(), time.start);
    assert.equal(end.timestamp.getTime(), time.end ?? time.start);
    assert.ok(end.sequenceNumber > start.sequenceNumber);
    const projection = new ProductProjection("session-fixture", "cold-epoch");
    for (const event of events) projection.applyEvent(event);
    const row = projection.getSnapshot().rows.window.find((item) => item.kind === "reasoning");
    assert.equal(row.createdAt, time.start);
    assert.equal(row.durationMs, expected);
    assert.equal(row.state, "complete");
  });
}

function summary(patch = {}) {
  return {
    sessionId: "session-fixture",
    workspaceId: "workspace-fixture",
    title: "fixture",
    phase: "running",
    sessionEnded: false,
    hasBackgroundWork: false,
    createdAt: BASE,
    lastActivityAt: BASE + 20_000,
    ...patch,
  };
}

async function hostFixture(initial) {
  const frames = new Emitter();
  const configs = new Emitter();
  const restarted = new Emitter();
  const changes = [];
  const lifecycle = [];
  const rows = new Map();
  const workspace = { workspacePath: "workspace-fixture" };
  const topic = sessionsIndexTopic(workspace.workspacePath);
  let seq = 0;
  let ordinal = 0;
  let logEpoch = "list-epoch";
  const agent = {
    onDynamicSessionsIndexFrame: () => frames.event,
    onDynamicWorkspaceConfigFrame: () => configs.event,
    onAgentRuntimeRestarted: restarted.event,
    subscribeSessionsIndexV4: async () => ({
      ack: { subscriptionId: "index-fixture", logEpoch, mode: "snapshot", seq0: 0 },
    }),
    subscribeWorkspaceConfigV4: async () => ({
      ack: {
        subscriptionId: "config-fixture",
        logEpoch: "config-epoch",
        mode: "snapshot",
        seq0: 0,
      },
    }),
    unsubscribeSessionsIndexV4: async () => {},
    unsubscribeWorkspaceConfigV4: async () => {},
    readSession: async () => {
      throw new Error("fixture read unavailable");
    },
  };
  const repo = {
    applyCliFacts: async ({ meta }) => {
      rows.set(meta.taskId, meta);
      return meta;
    },
    getTaskMeta: async ({ taskId }) => rows.get(taskId) ?? null,
    listTaskMetas: async () => [],
    listReconciliationRows: async () => [],
  };
  const syncer = createZCodeTaskIndexSyncer({ agentService: agent, taskIndexRepo: repo });
  syncer.onDynamicWorkspaceEvent(workspace)((event) => changes.push(event));
  syncer.onSessionTerminalEvent((event) => lifecycle.push(event.kind));
  syncer.onSessionReadyEvent((event) => lifecycle.push(event.reason));
  syncer.ensureWorkspaceSubscription(workspace);
  await settled();
  const send = async (session, kind = "deltas", options = {}) => {
    const fromSeq = seq;
    seq++;
    ordinal++;
    const payload =
      kind === "snapshot"
        ? {
            kind,
            snapshot: {
              protocolVersion: 1,
              workspaceId: workspace.workspacePath,
              logEpoch,
              sessions: [session],
            },
          }
        : { kind, deltas: [{ op: "session.upserted", session }] };
    frames.fire({
      wireVersion: V4_WIRE_PROTOCOL_VERSION,
      kind: "complete",
      deliveryKind: options.deliveryKind ?? (kind === "snapshot" ? "initial" : "online"),
      logicalFrameId: `frame-${ordinal}`,
      logicalFrameOrdinal: ordinal,
      topic,
      subscriptionId: "index-fixture",
      frame: {
        topic,
        subscriptionId: "index-fixture",
        fromSeq: kind === "snapshot" ? 0 : fromSeq,
        toSeq: seq,
        sentAt: BASE + seq,
        payload,
      },
    });
    await settled();
  };
  const restart = async (nextEpoch) => {
    logEpoch = nextEpoch;
    seq = 0;
    ordinal = 0;
    restarted.fire({ workspaceKey: workspace.workspacePath });
    await settled();
  };
  const snapshotEpoch = async (nextEpoch, session, options = {}) => {
    logEpoch = nextEpoch;
    seq = 0;
    await send(session, "snapshot", options);
  };
  await send(initial, "snapshot");
  return {
    send,
    restart,
    snapshotEpoch,
    changes,
    lifecycle,
    dispose: () => {
      syncer.disposeAll();
      frames.dispose();
      configs.dispose();
      restarted.dispose();
    },
  };
}

test("Host 自动队列交接不制造未读，队列清空同 phase 只补提醒、不重复 terminal/ready", async () => {
  const f = await hostFixture(summary());
  try {
    await f.send(
      summary({ phase: "completedSuccess", sessionEnded: true, autoContinuePending: true }),
    );
    assert.deepEqual(f.lifecycle, ["turn.completed", "prompt_completed"]);
    assert.equal(f.changes.filter((event) => event.unreadSignal).length, 0);
    await f.send(
      summary({ phase: "completedSuccess", sessionEnded: true, autoContinuePending: false }),
    );
    assert.equal(
      f.changes.filter((event) => event.unreadSignal === "background_terminal").length,
      1,
    );
    assert.equal(f.lifecycle.length, 2);
    await f.send(
      summary({ phase: "completedSuccess", sessionEnded: true, autoContinuePending: false }),
    );
    assert.equal(f.changes.filter((event) => event.unreadSignal).length, 1);
    assert.equal(f.lifecycle.length, 2);
  } finally {
    f.dispose();
  }
});

test("Host 冷成功不重放；held/旧摘要成功正常提醒，错误不吞，中断不提醒", async () => {
  const f = await hostFixture(summary({ phase: "completedSuccess", sessionEnded: true }));
  try {
    assert.equal(f.changes.length, 0);
    assert.equal(f.lifecycle.length, 0);
    for (const patch of [
      { phase: "completedSuccess", autoContinuePending: false },
      { phase: "completedSuccess" },
      { phase: "error", autoContinuePending: true },
      { phase: "completedInterrupted", autoContinuePending: true },
    ]) {
      await f.send(summary());
      await f.send(summary({ sessionEnded: true, ...patch }));
    }
    assert.equal(
      f.changes.filter((event) => event.unreadSignal === "background_terminal").length,
      3,
    );
    assert.equal(f.lifecycle.length, 8);
  } finally {
    f.dispose();
  }
});

test("Host Goal active/verifying/notSatisfied 不提醒，verified 同 phase 补一次提醒", async () => {
  const f = await hostFixture(summary());
  try {
    for (const goalStatus of ["active", "verifying", "notSatisfied"]) {
      await f.send(summary({ phase: "completedSuccess", sessionEnded: true, goalStatus }));
    }
    assert.equal(f.changes.filter((event) => event.unreadSignal).length, 0);
    await f.send(
      summary({ phase: "completedSuccess", sessionEnded: true, goalStatus: "verified" }),
    );
    assert.equal(
      f.changes.filter((event) => event.unreadSignal === "background_terminal").length,
      1,
    );
    assert.equal(f.lifecycle.length, 2);
  } finally {
    f.dispose();
  }
});

test("Host runtime 新 epoch 冷成功静默替换旧 running 或 Goal 基线", async () => {
  for (const initial of [
    summary(),
    summary({ phase: "completedSuccess", sessionEnded: true, goalStatus: "active" }),
  ]) {
    const f = await hostFixture(initial);
    try {
      await f.restart("new-epoch");
      await f.send(
        summary({ phase: "completedSuccess", sessionEnded: true, goalStatus: "verified" }),
        "snapshot",
      );
      assert.equal(f.changes.filter((event) => event.unreadSignal).length, 0);
      assert.equal(f.lifecycle.length, 0);
      await f.send(summary());
      await f.send(summary({ phase: "completedSuccess", sessionEnded: true }));
      assert.equal(f.changes.filter((event) => event.unreadSignal).length, 1);
      assert.equal(f.lifecycle.length, 2);
    } finally {
      f.dispose();
    }
  }
});

test("Host 无重订的新 epoch 低 seq snapshot 也静默收敛；同 epoch 陈旧 snapshot 丢弃", async () => {
  const f = await hostFixture(summary());
  try {
    await f.send(summary());
    await f.send(summary());
    await f.snapshotEpoch("new-epoch", summary({ phase: "completedSuccess", sessionEnded: true }), {
      deliveryKind: "online",
    });
    assert.equal(f.lifecycle.length, 0);
    assert.equal(f.changes.filter((event) => event.unreadSignal).length, 0);
    await f.send(summary());
    await f.snapshotEpoch("new-epoch", summary({ phase: "completedSuccess", sessionEnded: true }), {
      deliveryKind: "online",
    });
    assert.equal(f.lifecycle.length, 0);
    await f.send(summary());
    await f.send(summary({ phase: "completedSuccess", sessionEnded: true }));
    assert.equal(f.changes.filter((event) => event.unreadSignal).length, 1);
  } finally {
    f.dispose();
  }
});

test("Host 同 epoch 恢复 snapshot 保留遗漏的有效完成边沿，重复不提醒", async () => {
  const f = await hostFixture(
    summary({ phase: "completedSuccess", sessionEnded: true, autoContinuePending: true }),
  );
  try {
    const completed = summary({
      phase: "completedSuccess",
      sessionEnded: true,
      autoContinuePending: false,
    });
    await f.send(completed, "snapshot", { deliveryKind: "recovery" });
    assert.equal(f.changes.filter((event) => event.unreadSignal).length, 1);
    assert.equal(f.lifecycle.length, 0);
    await f.send(completed, "snapshot", { deliveryKind: "recovery" });
    assert.equal(f.changes.filter((event) => event.unreadSignal).length, 1);
    assert.equal(f.lifecycle.length, 0);
  } finally {
    f.dispose();
  }
});

test("Host 同 epoch 迟到 recovery snapshot 不倒退基线或重复完成提示", async () => {
  const f = await hostFixture(summary());
  try {
    await f.send(summary({ phase: "completedSuccess", sessionEnded: true }));
    assert.equal(f.changes.filter((event) => event.unreadSignal).length, 1);
    await f.snapshotEpoch("list-epoch", summary(), { deliveryKind: "recovery" });
    await f.send(summary({ phase: "completedSuccess", sessionEnded: true }));
    assert.equal(f.changes.filter((event) => event.unreadSignal).length, 1);
    assert.equal(f.lifecycle.length, 2);
  } finally {
    f.dispose();
  }
});
