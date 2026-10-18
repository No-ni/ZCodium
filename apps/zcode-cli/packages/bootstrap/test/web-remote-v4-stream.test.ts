import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import {
  conversationTopicFrameSchema,
  reassembleTopicWireFrames,
  type ConversationTopicFrame,
  type RoutedTopicWireFrame,
} from "@zcode/shared/zcode-protocol-v4";
import { ConversationV4Gateway, type V4GatewayHost } from "../src/zcode-protocol-v4/v4-gateway.js";

const sessionId = "mobile-live-stream";
const assistantMessageId = "assistant-message-1";
const topic = `conversation/${sessionId}`;

function decodeConversationFrame(wire: RoutedTopicWireFrame): ConversationTopicFrame | null {
  const result = reassembleTopicWireFrames([wire], conversationTopicFrameSchema);
  return result.kind === "complete" ? result.frame : null;
}

function assistantText(frame: ConversationTopicFrame): string {
  if (frame.payload.kind !== "snapshot") {
    assert.fail(`expected snapshot, received ${frame.payload.kind}`);
  }
  const row = frame.payload.snapshot.rows.window.find(
    (candidate) =>
      candidate.kind === "assistantText" && candidate.assistantResponseId === assistantMessageId,
  );
  assert.ok(row, "snapshot contains the in-progress assistant message");
  return row.text;
}

function textAppends(frame: ConversationTopicFrame): string[] {
  if (frame.payload.kind !== "deltas") {
    assert.fail(`expected deltas, received ${frame.payload.kind}`);
  }
  return frame.payload.deltas.flatMap((delta) =>
    delta.op === "row.delta" && delta.path === "text" ? [delta.append] : [],
  );
}

function toolInputAppends(frame: ConversationTopicFrame): string[] {
  if (frame.payload.kind !== "deltas") {
    assert.fail(`expected deltas, received ${frame.payload.kind}`);
  }
  return frame.payload.deltas.flatMap((delta) =>
    delta.op === "row.delta" && delta.path === "inputText" ? [delta.append] : [],
  );
}

test("desktop continuous delivery and web remote replayable recovery preserve one runtime stream", async () => {
  let sequenceNumber = 0;
  const wireWaiters = new Map<string, Array<(frame: ConversationTopicFrame) => void>>();
  const host = {
    sessionExists: (id: string) => id === sessionId,
    emitWireFrame: (wire: RoutedTopicWireFrame) => {
      const frame = decodeConversationFrame(wire);
      if (frame?.topic !== topic) return;
      const waiters = wireWaiters.get(frame.subscriptionId);
      const waiter = waiters?.shift();
      if (!waiters?.length) wireWaiters.delete(frame.subscriptionId);
      waiter?.(frame);
    },
    getSessionWorkspacePath: () => null,
  } as V4GatewayHost;
  const gateway = new ConversationV4Gateway(host, {
    createLogEpoch: () => "mobile-v4-stream-test",
  });
  const event = (type: SessionEvent["type"], payload: unknown): SessionEvent =>
    ({
      id: randomUUID(),
      sessionId,
      turnId: "turn-1",
      type,
      payload,
      timestamp: new Date(),
      sequenceNumber: ++sequenceNumber,
    }) as SessionEvent;
  const streamEvent = (delta: string): SessionEvent =>
    event(SessionEventType.ModelStreaming, {
      kind: "text_delta",
      delta,
      done: false,
      assistantMessageId,
      partId: "assistant-part-1",
    });
  const toolInputEvent = (kind: "tool_input_start" | "tool_input_delta", delta: string) =>
    event(SessionEventType.ModelStreaming, {
      kind,
      delta,
      done: false,
      toolCallId: "tool-call-1",
      toolName: "Bash",
    });
  const waitForOnlineFrame = (subscriptionId: string) =>
    new Promise<ConversationTopicFrame>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const waiters = wireWaiters.get(subscriptionId);
        const index = waiters?.indexOf(onFrame) ?? -1;
        if (index >= 0) waiters?.splice(index, 1);
        if (!waiters?.length) wireWaiters.delete(subscriptionId);
        reject(new Error("timed out waiting for a V4 online wire frame"));
      }, 5_000);
      const onFrame = (frame: ConversationTopicFrame) => {
        clearTimeout(timeout);
        resolve(frame);
      };
      const waiters = wireWaiters.get(subscriptionId) ?? [];
      waiters.push(onFrame);
      wireWaiters.set(subscriptionId, waiters);
    });

  try {
    gateway.ingest(
      sessionId,
      event(SessionEventType.TurnStarted, { inputId: "input-1", turnNumber: 1 }),
    );
    gateway.ingest(
      sessionId,
      event(SessionEventType.ModelStreaming, {
        kind: "text_start",
        delta: "",
        done: false,
        assistantMessageId,
        partId: "assistant-part-1",
      }),
    );
    gateway.ingest(sessionId, streamEvent("generated-before-open"));
    gateway.ingest(sessionId, toolInputEvent("tool_input_start", ""));

    const desktop = await gateway.subscribe({
      topic,
      connectionId: "desktop-connection-1",
      clientMode: "desktop-continuous",
    });
    const web = await gateway.subscribe({
      topic,
      connectionId: "web-connection-1",
      clientMode: "web-remote-replayable",
    });
    const desktopSnapshot = desktop.initialFrame;
    const webSnapshot = web.initialFrame;
    assert.ok(desktopSnapshot, "desktop subscription returns its initial snapshot");
    assert.ok(webSnapshot, "web subscription returns its initial snapshot");
    assert.equal(desktopSnapshot.payload.kind, "snapshot");
    assert.equal(webSnapshot.payload.kind, "snapshot");
    assert.equal(desktop.ack.mode, "snapshot");
    assert.equal(web.ack.mode, "snapshot");
    assert.equal(assistantText(desktopSnapshot), "generated-before-open");
    assert.equal(assistantText(webSnapshot), "generated-before-open");
    let desktopBase = { logEpoch: desktop.ack.logEpoch, seq: desktopSnapshot.toSeq };
    let webBase = { logEpoch: web.ack.logEpoch, seq: webSnapshot.toSeq };

    const desktopLivePromise = waitForOnlineFrame(desktop.ack.subscriptionId);
    const webLivePromise = waitForOnlineFrame(web.ack.subscriptionId);
    gateway.ingest(sessionId, toolInputEvent("tool_input_delta", "--desktop-preview"));
    gateway.ingest(sessionId, streamEvent("-while-connected"));
    const [desktopLiveFrame, webLiveFrame] = await Promise.all([
      desktopLivePromise,
      webLivePromise,
    ]);
    assert.equal(desktopLiveFrame.subscriptionId, desktop.ack.subscriptionId);
    assert.equal(webLiveFrame.subscriptionId, web.ack.subscriptionId);
    assert.equal(desktopLiveFrame.fromSeq, desktopBase.seq);
    assert.equal(webLiveFrame.fromSeq, webBase.seq);
    assert.equal(desktopLiveFrame.toSeq, webLiveFrame.toSeq);
    assert.deepEqual(textAppends(desktopLiveFrame), ["-while-connected"]);
    assert.deepEqual(textAppends(webLiveFrame), ["-while-connected"]);
    assert.deepEqual(toolInputAppends(desktopLiveFrame), ["--desktop-preview"]);
    assert.deepEqual(toolInputAppends(webLiveFrame), []);
    desktopBase = { logEpoch: desktop.ack.logEpoch, seq: desktopLiveFrame.toSeq };
    webBase = { logEpoch: web.ack.logEpoch, seq: webLiveFrame.toSeq };

    gateway.unsubscribe({
      topic,
      connectionId: "web-connection-1",
      subscriptionId: web.ack.subscriptionId,
    });
    const desktopGapPromise = waitForOnlineFrame(desktop.ack.subscriptionId);
    gateway.ingest(sessionId, streamEvent("-while-disconnected"));
    const desktopGapFrame = await desktopGapPromise;
    assert.equal(desktopGapFrame.fromSeq, desktopBase.seq);
    assert.ok(desktopGapFrame.toSeq > desktopGapFrame.fromSeq);
    assert.deepEqual(textAppends(desktopGapFrame), ["-while-disconnected"]);

    const reconnected = await gateway.subscribe({
      topic,
      connectionId: "web-connection-2",
      clientMode: "web-remote-replayable",
      base: webBase,
    });
    const recovered = reconnected.initialFrame;
    assert.ok(recovered, "web reconnect returns the missed delta range");
    assert.equal(reconnected.ack.mode, "resume");
    assert.equal(recovered.payload.kind, "deltas");
    assert.equal(recovered.fromSeq, webBase.seq);
    assert.ok(recovered.toSeq > recovered.fromSeq);
    assert.deepEqual(textAppends(recovered), ["-while-disconnected"]);
    assert.equal(recovered.fromSeq, desktopGapFrame.fromSeq);
    assert.equal(recovered.toSeq, desktopGapFrame.toSeq);

    const desktopPostReconnectPromise = waitForOnlineFrame(desktop.ack.subscriptionId);
    const webPostReconnectPromise = waitForOnlineFrame(reconnected.ack.subscriptionId);
    gateway.ingest(sessionId, streamEvent("-after-reconnect"));
    const [desktopPostReconnectFrame, webPostReconnectFrame] = await Promise.all([
      desktopPostReconnectPromise,
      webPostReconnectPromise,
    ]);
    assert.equal(desktopPostReconnectFrame.subscriptionId, desktop.ack.subscriptionId);
    assert.equal(webPostReconnectFrame.subscriptionId, reconnected.ack.subscriptionId);
    assert.equal(desktopPostReconnectFrame.fromSeq, desktopGapFrame.toSeq);
    assert.equal(webPostReconnectFrame.fromSeq, recovered.toSeq);
    assert.equal(desktopPostReconnectFrame.toSeq, webPostReconnectFrame.toSeq);
    assert.deepEqual(textAppends(desktopPostReconnectFrame), ["-after-reconnect"]);
    assert.deepEqual(textAppends(webPostReconnectFrame), ["-after-reconnect"]);

    assert.equal(
      [
        assistantText(desktopSnapshot),
        ...textAppends(desktopLiveFrame),
        ...textAppends(desktopGapFrame),
        ...textAppends(desktopPostReconnectFrame),
      ].join(""),
      "generated-before-open-while-connected-while-disconnected-after-reconnect",
    );
    assert.equal(
      [
        assistantText(webSnapshot),
        ...textAppends(webLiveFrame),
        ...textAppends(recovered),
        ...textAppends(webPostReconnectFrame),
      ].join(""),
      "generated-before-open-while-connected-while-disconnected-after-reconnect",
    );
  } finally {
    gateway.dispose();
  }
});
