import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  createSessionEvent,
  SessionEventType,
} from "../../../apps/zcode-cli/packages/contracts/src/index.ts";
import { ConversationV4Gateway } from "../../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/index.ts";
import {
  sessionsIndexTopicFrameSchema,
  sessionSummarySchema,
} from "../../../packages/shared/src/zcode-protocol-v4/index.ts";
import { taskNotificationPayloadSchema } from "../../../packages/shared/src/index.ts";

// 真实 gateway/publisher/projection；存储、模型和物理传输仅为内存端口，不读用户目录。
const gateways = [];
const sessionId = "notification-session";
const workspaceId = "notification-workspace";
const target = {
  targetID: "notification-target",
  objective: "Synthetic objective",
  status: "active",
  timeUsedSeconds: 0,
};
async function fixture({ stored = [] } = {}) {
  let seq = 0;
  let summary;
  const readFrame = (frame) => {
    if (!frame?.topic.startsWith("sessions-index/")) return;
    frame = sessionsIndexTopicFrameSchema.parse(frame);
    if (frame.payload.kind === "snapshot")
      summary = frame.payload.snapshot.sessions.find((item) => item.sessionId === sessionId);
    else
      for (const delta of frame.payload.deltas)
        if (delta.op === "session.upserted" && delta.session.sessionId === sessionId)
          summary = delta.session;
  };
  const gateway = new ConversationV4Gateway(
    {
      sessionExists: (id) => id === sessionId,
      executeCommand: async () => undefined,
      loadPersistedEvents: async () => ({ events: [], synthesized: false }),
      getSessionWorkspaceId: () => workspaceId,
      // 固定时间证明身份不依赖 lastActivityAt 或时钟推进。
      getSessionIndexMeta: () => ({ createdAt: 1, lastActivityAt: 100 }),
      listWorkspaceSessionIds: () => [sessionId],
      getStoredSessionSummaries: () => stored,
      isDraftSession: () => false,
      emitWireFrame(wire) {
        assert.equal(wire.kind, "complete");
        readFrame(wire.frame);
      },
    },
    { now: () => 1000, createLogEpoch: () => "notification-index-epoch" },
  );
  gateways.push(gateway);
  function publish(type, payload, turnId = "notification-turn-a") {
    const event = createSessionEvent(type, sessionId, payload, {
      sequenceNumber: ++seq,
      turnId,
      traceId: "synthetic-trace",
    });
    gateway.ingest(sessionId, event);
    return event;
  }
  publish(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
  const subscription = await gateway.subscribeSessionsIndex({
    topic: `sessions-index/${workspaceId}`,
    connectionId: "notification-connection",
    clientMode: "desktop-continuous",
  });
  readFrame(subscription.initialFrame);
  assert.equal(subscription.commit(), true);
  return {
    gateway,
    publish,
    get summary() {
      return summary;
    },
    start(turnId = "notification-turn-a") {
      return publish(
        SessionEventType.TurnStarted,
        { turnNumber: seq + 1, input: "Synthetic input", messageId: `${turnId}-message` },
        turnId,
      );
    },
  };
}
afterEach(() => {
  for (const gateway of gateways.splice(0)) gateway.dispose();
});

test("两次真实成功事件各有稳定身份，标题和活动更新不替换同一身份", async () => {
  const f = await fixture();
  f.start();
  const first = f.publish(SessionEventType.TurnComplete, { resultType: "success", durationMs: 1 });
  assert.equal(f.summary.notificationEventId, first.id);
  f.publish(SessionEventType.SessionTitleUpdated, { title: "Synthetic renamed", source: "custom" });
  assert.equal(f.summary.notificationEventId, first.id);
  f.start("notification-turn-b");
  const second = f.publish(
    SessionEventType.TurnComplete,
    { resultType: "success", durationMs: 1 },
    "notification-turn-b",
  );
  assert.equal(f.summary.notificationEventId, second.id);
  assert.notEqual(first.id, second.id);
  assert.equal(f.summary.lastActivityAt, 100);
});
test("两次真实失败边沿使用各自 TurnError 身份", async () => {
  const f = await fixture();
  f.start();
  const fail = () =>
    f.publish(SessionEventType.TurnError, {
      error: { type: "unknown", message: "Synthetic failure" },
    });
  const first = fail();
  assert.equal(f.summary.phase, "error");
  assert.equal(f.summary.notificationEventId, first.id);
  f.start("notification-turn-b");
  const second = fail();
  assert.equal(f.summary.notificationEventId, second.id);
  assert.notEqual(first.id, second.id);
});
test("Goal 最终验证的同 phase 资格边沿使用 TargetChanged 事实身份", async () => {
  const f = await fixture();
  f.start();
  f.publish(SessionEventType.TargetChanged, { action: "set", source: "command", target });
  f.publish(SessionEventType.TurnComplete, { resultType: "success", durationMs: 1 });
  assert.equal(f.summary.phase, "completedSuccess");
  assert.equal(f.summary.notificationEventId, undefined);
  const first = f.publish(SessionEventType.TargetChanged, {
    action: "status_updated",
    source: "runtime",
    target: { ...target, status: "complete" },
  });
  assert.equal(f.summary.goalStatus, "verified");
  assert.equal(f.summary.notificationEventId, first.id);
  f.publish(SessionEventType.TargetChanged, { action: "set", source: "command", target });
  const second = f.publish(SessionEventType.TargetChanged, {
    action: "status_updated",
    source: "runtime",
    target: { ...target, status: "complete" },
  });
  assert.equal(f.summary.phase, "completedSuccess");
  assert.equal(f.summary.notificationEventId, second.id);
});
test("自动队列 held/清空的同 phase 资格边沿保留各自真实 queue 事件身份", async () => {
  const f = await fixture();
  f.start();
  f.publish(SessionEventType.QueueAutoDrainChanged, { autoDrain: true });
  f.publish(SessionEventType.TurnSteerQueued, {
    pendingInputId: "notification-queue",
    input: "Synthetic future input",
    inputPreview: "Synthetic future input",
    inputSize: 22,
    queueLength: 1,
    targetTurnId: "notification-turn-a",
  });
  f.publish(SessionEventType.TurnComplete, { resultType: "success", durationMs: 1 });
  assert.equal(f.summary.autoContinuePending, true);
  assert.equal(f.summary.notificationEventId, undefined);
  const held = f.publish(SessionEventType.QueueAutoDrainChanged, { autoDrain: false });
  assert.equal(f.summary.notificationEventId, held.id);
  f.publish(SessionEventType.QueueAutoDrainChanged, { autoDrain: true });
  const cleared = f.publish(SessionEventType.TurnSteerDiscarded, {
    pendingInputIds: ["notification-queue"],
    reason: "removed",
  });
  assert.equal(f.summary.phase, "completedSuccess");
  assert.equal(f.summary.notificationEventId, cleared.id);
});
test("冷 seed/rehydrate 不用时钟或非事件调用制造通知身份", async () => {
  const seed = {
    sessionId,
    workspaceId,
    title: "Synthetic stored",
    phase: "completedSuccess",
    sessionEnded: true,
    hasBackgroundWork: false,
    lastActivityAt: 100,
    createdAt: 1,
  };
  const f = await fixture({ stored: [seed] });
  assert.equal(f.summary.notificationEventId, undefined);
  assert.equal(sessionSummarySchema.parse(seed).notificationEventId, undefined);
});
test("可选身份严格验证且旧 summary/payload 仍兼容", () => {
  const legacy = {
    sessionId,
    workspaceId,
    title: "Synthetic",
    phase: "completedSuccess",
    sessionEnded: true,
    hasBackgroundWork: false,
    lastActivityAt: 100,
    createdAt: 1,
  };
  assert.equal(sessionSummarySchema.safeParse(legacy).success, true);
  assert.equal(
    sessionSummarySchema.parse({ ...legacy, notificationEventId: "synthetic-event" })
      .notificationEventId,
    "synthetic-event",
  );
  for (const notificationEventId of ["", 7, null])
    assert.equal(sessionSummarySchema.safeParse({ ...legacy, notificationEventId }).success, false);
  const payload = {
    taskId: sessionId,
    status: "completed",
    title: "Synthetic complete",
    body: "Synthetic task",
  };
  assert.equal(taskNotificationPayloadSchema.safeParse(payload).success, true);
  for (const notificationId of ["", 7, null])
    assert.equal(
      taskNotificationPayloadSchema.safeParse({ ...payload, notificationId }).success,
      false,
    );
});
