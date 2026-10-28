import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { CoreErrorType, SessionEventType, type SessionEvent } from "@zcode/contracts";
import {
  applyConversationDeltas,
  conversationTopicFrameSchema,
  type ConversationSnapshot,
  type ConversationTopicFrame,
  type ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";
import { ConversationV4Gateway, type V4GatewayHost } from "../src/zcode-protocol-v4/v4-gateway.js";

const SESSION_ID = "tool-search-gateway-fixture";
const TOPIC = `conversation/${SESSION_ID}`;
const TARGET = "FixtureDeferredLookup";
const REAL_INPUT = { value: "fixture" };
const WRAPPER_INPUT = { name: TARGET, input: REAL_INPUT };
const DISPLAY = {
  kind: "tool_search" as const,
  query: `select:${TARGET}`,
  matches: [TARGET],
  totalMatches: 1,
  totalDeferredTools: 1,
};

function applyFrame(
  snapshot: ConversationSnapshot,
  rawFrame: ConversationTopicFrame | null | undefined,
): ConversationSnapshot {
  assert.ok(rawFrame, "real gateway produces a frame");
  const frame = conversationTopicFrameSchema.parse(rawFrame);
  if (frame.payload.kind === "snapshot") return frame.payload.snapshot;
  assert.equal(frame.payload.kind, "deltas");
  assert.equal(frame.fromSeq, snapshot.seq, "delivery keeps its authoritative cursor");
  return {
    ...applyConversationDeltas(snapshot, frame.payload.deltas),
    seq: frame.toSeq,
  };
}

function toolRow(snapshot: ConversationSnapshot, toolCallId: string): ToolCallRow {
  const row = snapshot.rows.window.find(
    (candidate) => candidate.kind === "toolCall" && candidate.toolCallId === toolCallId,
  );
  assert.ok(row?.kind === "toolCall", `tool row exists for ${toolCallId}`);
  return row;
}

function fixture() {
  let sequenceNumber = 0;
  const events: SessionEvent[] = [];
  const host = {
    sessionExists: (id: string) => id === SESSION_ID,
    emitWireFrame: () => assert.fail("fixture flushes explicitly, without network or timer waits"),
    getSessionWorkspacePath: () => null,
  } as V4GatewayHost;
  const gateway = new ConversationV4Gateway(host, {
    createLogEpoch: () => "tool-search-gateway-epoch",
  });
  const emit = (type: SessionEvent["type"], payload: unknown) => {
    const event = {
      id: randomUUID(),
      sessionId: SESSION_ID,
      turnId: "fixture-turn",
      type,
      payload,
      timestamp: new Date(),
      sequenceNumber: ++sequenceNumber,
    } as SessionEvent;
    events.push(event);
    gateway.ingest(SESSION_ID, event);
  };
  const stream = (toolCallId: string, kind: string, toolName: string, input?: unknown) =>
    emit(SessionEventType.ModelStreaming, {
      kind,
      delta: kind === "tool_input_delta" ? JSON.stringify(input) : "",
      done: kind === "tool_call",
      assistantMessageId: "fixture-assistant",
      toolCallId,
      toolName,
      ...(kind === "tool_call" ? { input } : {}),
    });
  const schedule = (toolCallId: string, toolName = TARGET, input: unknown = REAL_INPUT) =>
    emit(SessionEventType.ToolCallScheduled, {
      toolCallId,
      toolName,
      input,
      assistantMessageId: "fixture-assistant",
      schedule: { parallelGroups: [[toolCallId]], executionOrder: [toolCallId] },
    });
  const result = (toolCallId: string, toolName: string, display = false) =>
    emit(SessionEventType.ToolCallResult, {
      toolCallId,
      result: {
        toolName,
        success: true,
        content: "fixture successful output",
        ...(display ? { display: DISPLAY } : {}),
      },
      duration: 1,
    });
  emit(SessionEventType.TurnStarted, {
    inputId: "fixture-input",
    messageId: "fixture-user",
    input: "fixture",
    turnNumber: 1,
  });
  return { gateway, host, events, emit, stream, schedule, result };
}

test("real gateway preserves ToolSearch display across desktop live, mobile gap repair and snapshot", async () => {
  const { gateway, host, events, stream, schedule, result } = fixture();
  let cold: ConversationV4Gateway | undefined;
  try {
    const desktop = await gateway.subscribe({
      topic: TOPIC,
      connectionId: "fixture-desktop",
      clientMode: "desktop-continuous",
    });
    const mobile = await gateway.subscribe({
      topic: TOPIC,
      connectionId: "fixture-mobile",
      clientMode: "web-remote-replayable",
    });
    assert.equal(desktop.initialFrame?.payload.kind, "snapshot");
    assert.equal(mobile.initialFrame?.payload.kind, "snapshot");
    let desktopState = (desktop.initialFrame!.payload as { snapshot: ConversationSnapshot })
      .snapshot;
    let mobileState = (mobile.initialFrame!.payload as { snapshot: ConversationSnapshot }).snapshot;
    stream("search-call", "tool_input_start", "ToolSearch");
    schedule("search-call", "ToolSearch", { query: DISPLAY.query });
    result("search-call", "ToolSearch", true);
    desktopState = applyFrame(desktopState, gateway.flushNow(desktop.ack.subscriptionId));
    mobileState = applyFrame(mobileState, gateway.flushNow(mobile.ack.subscriptionId));
    for (const state of [desktopState, mobileState]) {
      const row = toolRow(state, "search-call");
      assert.equal(row.status, "success");
      assert.deepEqual(row.display, DISPLAY, "row-level authoritative display is retained");
      assert.deepEqual(row.output?.display, DISPLAY);
    }
    stream("wrapped-call", "tool_input_start", "DeferredToolCall");
    stream("wrapped-call", "tool_input_delta", "DeferredToolCall", WRAPPER_INPUT);
    const desktopPreview = gateway.flushNow(desktop.ack.subscriptionId)!;
    const mobilePreview = gateway.flushNow(mobile.ack.subscriptionId)!;
    assert.equal(desktopPreview.payload.kind, "deltas");
    assert.equal(mobilePreview.payload.kind, "deltas");
    if (desktopPreview.payload.kind === "deltas" && mobilePreview.payload.kind === "deltas") {
      assert.ok(desktopPreview.payload.deltas.some((delta) => delta.op === "row.delta"));
      assert.ok(!mobilePreview.payload.deltas.some((delta) => delta.op === "row.delta"));
    }
    desktopState = applyFrame(desktopState, desktopPreview);
    mobileState = applyFrame(mobileState, mobilePreview);
    gateway.unsubscribe({
      topic: TOPIC,
      connectionId: "fixture-mobile",
      subscriptionId: mobile.ack.subscriptionId,
    });
    stream("wrapped-call", "tool_call", TARGET, REAL_INPUT);
    // 在 scheduled 之前先检查完整模型调用，避免另一个事件掩盖预览名称未被替换的 bug。
    desktopState = applyFrame(desktopState, gateway.flushNow(desktop.ack.subscriptionId));
    assert.equal(toolRow(desktopState, "wrapped-call").toolName, TARGET);
    schedule("wrapped-call");
    result("wrapped-call", TARGET);
    desktopState = applyFrame(desktopState, gateway.flushNow(desktop.ack.subscriptionId));
    const repaired = await gateway.subscribe({
      topic: TOPIC,
      connectionId: "fixture-mobile-2",
      clientMode: "web-remote-replayable",
      base: { logEpoch: mobile.ack.logEpoch, seq: mobileState.seq },
    });
    assert.equal(repaired.ack.mode, "resume");
    mobileState = applyFrame(mobileState, repaired.initialFrame);
    assert.deepEqual(toolRow(mobileState, "wrapped-call"), toolRow(desktopState, "wrapped-call"));
    assert.deepEqual(toolRow(mobileState, "wrapped-call").input, REAL_INPUT);
    assert.equal(toolRow(mobileState, "wrapped-call").inputText, JSON.stringify(REAL_INPUT));
    const snapshot = await gateway.subscribe({
      topic: TOPIC,
      connectionId: "fixture-mobile-snapshot",
      clientMode: "web-remote-replayable",
    });
    const snapshotState = applyFrame(mobileState, snapshot.initialFrame);
    assert.deepEqual(toolRow(snapshotState, "search-call"), toolRow(mobileState, "search-call"));
    assert.deepEqual(toolRow(snapshotState, "wrapped-call"), toolRow(mobileState, "wrapped-call"));
    // 只重放已知事件，既不恢复 Agent，也不读取用户 store；验证冷 publisher 使用同一事实。
    cold = new ConversationV4Gateway(
      {
        ...host,
        loadPersistedEvents: async () => ({ events, synthesized: false }),
      },
      {
        createLogEpoch: () => "tool-search-gateway-cold-epoch",
      },
    );
    const coldSubscription = await cold.subscribe({
      topic: TOPIC,
      connectionId: "fixture-cold-mobile",
      clientMode: "web-remote-replayable",
    });
    const coldState = applyFrame(mobileState, coldSubscription.initialFrame);
    assert.deepEqual(toolRow(coldState, "search-call"), toolRow(mobileState, "search-call"));
    assert.deepEqual(toolRow(coldState, "wrapped-call"), toolRow(mobileState, "wrapped-call"));
  } finally {
    gateway.dispose();
    cold?.dispose();
  }
});

test("scheduled-only canonical target keeps real identity for running, approval, deny, error and cancellation", async () => {
  const { gateway, emit, stream, schedule, result } = fixture();
  try {
    const desktop = await gateway.subscribe({
      topic: TOPIC,
      connectionId: "fixture-desktop",
      clientMode: "desktop-continuous",
    });
    const mobile = await gateway.subscribe({
      topic: TOPIC,
      connectionId: "fixture-mobile",
      clientMode: "web-remote-replayable",
    });
    let desktopState = (desktop.initialFrame!.payload as { snapshot: ConversationSnapshot })
      .snapshot;
    let mobileState = (mobile.initialFrame!.payload as { snapshot: ConversationSnapshot }).snapshot;
    for (const status of [
      "running",
      "pendingApproval",
      "denied",
      "error",
      "cancelled",
      "success",
    ] as const) {
      const callId = `wrapped-${status}`;
      stream(callId, "tool_input_start", "DeferredToolCall");
      stream(callId, "tool_input_delta", "DeferredToolCall", WRAPPER_INPUT);
      schedule(callId);
      emit(SessionEventType.ToolCallStarted, {
        toolCallId: callId,
        toolName: TARGET,
        startedAt: new Date(),
      });
      if (status === "pendingApproval" || status === "denied") {
        emit(SessionEventType.PermissionRequested, {
          toolCallId: callId,
          toolName: TARGET,
          input: REAL_INPUT,
          riskLevel: "low",
          reason: "fixture approval",
        });
      }
      if (status === "denied") {
        emit(SessionEventType.PermissionDenied, {
          toolCallId: callId,
          toolName: TARGET,
          reason: "fixture denied",
        });
      }
      if (status === "error" || status === "cancelled") {
        emit(SessionEventType.ToolCallError, {
          toolCallId: callId,
          error: {
            type: status === "cancelled" ? CoreErrorType.ToolCancelled : "fixture_tool_failed",
            message: "fixture error",
          },
        });
      }
      if (status === "success") result(callId, TARGET);
      desktopState = applyFrame(desktopState, gateway.flushNow(desktop.ack.subscriptionId));
      mobileState = applyFrame(mobileState, gateway.flushNow(mobile.ack.subscriptionId));
      const row = toolRow(desktopState, callId);
      assert.equal(row.toolName, TARGET);
      // V4 既有协议把权限拒绝投影为 cancelled；不借 ToolSearch 改写该产品语义。
      assert.equal(row.status, status === "denied" ? "cancelled" : status);
      assert.deepEqual(row.input, REAL_INPUT);
      assert.equal(row.inputText, JSON.stringify(REAL_INPUT));
      assert.equal(row.display, undefined, "target never receives a ToolSearch success card");
      assert.deepEqual(toolRow(mobileState, callId), row);
    }
  } finally {
    gateway.dispose();
  }
});
