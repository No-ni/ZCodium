import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tsImport } from "tsx/esm/api";

const { ConversationV4Gateway } = await tsImport(
  "../../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts",
  import.meta.url,
);
const { createZCodeAgentConnectionScope, readTrustedZCodeAgentV4Connection } = await tsImport(
  "../../../packages/services/src/zcode-agent/zcodeAgentConnectionScope.ts",
  import.meta.url,
);
const { SessionEventType } = await tsImport(
  "../../../apps/zcode-cli/packages/contracts/src/index.ts",
  import.meta.url,
);
const { zcodeSessionMessagesResultSchema } = await tsImport(
  "../../../packages/shared/src/index.ts",
  import.meta.url,
);

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// 仅 admission/持久存储是合成业务输入；投影、分片、订阅水位和 attachment ownership 使用生产实现。
export function createMobileV4Fixture({
  messages,
  Emitter,
  sessionId = "fixture-task",
  workspacePath = "/fixture",
  workspaceIdentity = "fixture-identity",
  remoteSessionId,
}) {
  zcodeSessionMessagesResultSchema.parse({ messages });
  const frames = new Emitter();
  const runtime = new Emitter();
  const runtimeLifecycle = new Emitter();
  const commandAcks = new Map();
  const executions = new Map();
  const sentCommandIds = [];
  const queriedCommandIds = new Set();
  const unavailableQueries = new Set();
  let omitNextProjection = false;
  let sequenceNumber = 0;
  let turnNumber = 0;
  let currentTurn = "";
  let assistantMessageId = "";
  let initialGate;
  let nextAck;
  let suppressed = false;
  let prompt;
  let subscriptionCount = 0;
  const gateway = new ConversationV4Gateway(
    {
      sessionExists: (id) => id === sessionId,
      getSessionWorkspacePath: () => null,
      emitWireFrame: (wire) => {
        if (!suppressed) frames.fire(wire);
      },
    },
    { createLogEpoch: () => "mobile-smoke-epoch" },
  );
  const ingest = (type, payload) =>
    gateway.ingest(sessionId, {
      id: randomUUID(),
      sessionId,
      turnId: currentTurn,
      type,
      payload,
      timestamp: new Date(),
      sequenceNumber: ++sequenceNumber,
    });
  const startTurn = (text, commandId, messageId = randomUUID()) => {
    currentTurn = `turn-${++turnNumber}`;
    ingest(SessionEventType.TurnStarted, {
      inputId: commandId ?? `historical-input-${turnNumber}`,
      input: text,
      messageId,
      turnNumber,
      ...(text === "" ? { inputVisibility: "model-only" } : {}),
    });
  };
  const startAssistant = (id) => {
    assistantMessageId = id;
    ingest(SessionEventType.ModelStreaming, {
      kind: "text_start",
      delta: "",
      done: false,
      assistantMessageId,
      partId: `${assistantMessageId}-part`,
    });
  };
  const appendAssistant = (text) => {
    if (!assistantMessageId) startAssistant(`fixture-live-assistant-${turnNumber}`);
    ingest(SessionEventType.ModelStreaming, {
      kind: "text_delta",
      delta: text,
      done: false,
      assistantMessageId,
      partId: `${assistantMessageId}-part`,
    });
  };
  for (const message of messages) {
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    if (message.info.role === "user") startTurn(text, undefined, message.info.messageId);
    else {
      if (!currentTurn) startTurn("");
      startAssistant(message.info.messageId);
      appendAssistant(text);
      ingest(SessionEventType.ModelStreaming, {
        kind: "text_end",
        delta: "",
        done: true,
        assistantMessageId,
        partId: `${assistantMessageId}-part`,
      });
      ingest(SessionEventType.TurnComplete, {
        inputId: `historical-input-${turnNumber}`,
        resultType: "success",
        response: text,
        tokenCount: 0,
        toolCallCount: 0,
        duration: 0,
      });
      assistantMessageId = "";
      currentTurn = "";
    }
  }
  startTurn("生成中会话", "live-input");
  startAssistant("fixture-live-assistant");
  appendAssistant("进入前已生成的前缀");

  const assertTarget = (params) => {
    assert.equal(params.workspacePath, workspacePath);
    assert.equal(params.workspaceIdentity, workspaceIdentity);
    assert.equal(params.remoteSessionId, remoteSessionId);
  };

  const base = {
    onAgentRuntimeRestarted: runtime.event,
    onAgentRuntimeLifecycle: runtimeLifecycle.event,
    onDynamicConversationFrame: () => frames.event,
    async subscribeConversationV4(params) {
      assertTarget(params);
      subscriptionCount++;
      const trusted = readTrustedZCodeAgentV4Connection(params);
      assert.equal(trusted?.clientMode, "web-remote-replayable");
      const dispatch = await gateway.subscribeReserved({
        topic: `conversation/${params.sessionId}`,
        ...trusted,
        ...(params.base ? { base: params.base } : {}),
      });
      const gate = initialGate;
      initialGate = undefined;
      if (gate) {
        gate.entered.resolve();
        await gate.release.promise;
      }
      for (const wire of dispatch.initialWires) frames.fire(wire);
      dispatch.commit();
      return { ack: dispatch.ack };
    },
    async unsubscribeConversationV4(params) {
      const route = params.__zcodeTrustedV4UnsubscribeRoute;
      if (route) gateway.unsubscribe({ ...route, subscriptionId: params.subscriptionId });
    },
    async resyncConversationV4(params) {
      const route = params.__zcodeTrustedV4UnsubscribeRoute;
      const dispatch = gateway.resyncReserved({
        ...route,
        subscriptionId: params.subscriptionId,
        base: params.base,
        ...(params.forceSnapshot ? { forceSnapshot: true } : {}),
      });
      for (const wire of dispatch.initialWires) frames.fire(wire);
      dispatch.commit();
      return { ack: dispatch.ack };
    },
    async sendConversationCommandV4(params) {
      assertTarget(params);
      const { envelope } = params;
      const trusted = readTrustedZCodeAgentV4Connection(params);
      assert.equal(trusted?.clientMode, "web-remote-replayable");
      assert.equal(envelope.type, "sendText");
      assert.equal(envelope.sessionId, sessionId);
      sentCommandIds.push(envelope.commandId);
      const previous = commandAcks.get(envelope.commandId);
      if (previous) return { ...previous, status: "duplicate" };
      prompt = envelope;
      executions.set(envelope.commandId, (executions.get(envelope.commandId) ?? 0) + 1);
      // 对账故障验收需要缺少投影锚点，避免快照先确认输入而绕过查询分支。
      if (omitNextProjection) omitNextProjection = false;
      else startTurn(envelope.payload.text, envelope.commandId);
      assistantMessageId = "";
      const ack = { commandId: envelope.commandId, status: "accepted", revisionAtDecision: 0 };
      commandAcks.set(envelope.commandId, ack);
      const hold = nextAck;
      nextAck = undefined;
      if (hold) {
        hold.accepted.resolve({ envelope, ack });
        const options = await hold.release.promise;
        if (options?.reject) throw new Error("injected post-admission response loss");
        if (options?.drop) return new Promise(() => {});
      }
      return ack;
    },
    async queryConversationCommandsV4(params) {
      assertTarget(params);
      for (const key of params.commands) {
        assert.equal(key.sessionId, sessionId, "query must target the admitted session");
        queriedCommandIds.add(key.commandId);
      }
      return {
        results: params.commands.map((key) => ({
          key,
          result: unavailableQueries.has(key.commandId)
            ? {
                commandId: key.commandId,
                status: "failed",
                reasonCode: "fault.command.queryUnavailable",
                revisionAtDecision: 0,
              }
            : (commandAcks.get(key.commandId) ?? "unknown"),
        })),
      };
    },
    async conversationRowsRangeV4(params) {
      const trusted = readTrustedZCodeAgentV4Connection(params);
      return gateway.rowsRange({
        sessionId: params.sessionId,
        beforeRowId: params.beforeRowId,
        limit: params.limit,
        clientMode: trusted.clientMode,
      });
    },
  };
  return {
    attach(connectionId) {
      return createZCodeAgentConnectionScope(base, {
        connectionId,
        clientMode: "web-remote-replayable",
      });
    },
    appendAssistant,
    suppressFrames(value) {
      suppressed = value;
    },
    getPrompt() {
      return prompt;
    },
    omitProjectionForNextCommand() {
      omitNextProjection = true;
    },
    makeQueryUnavailable(commandId) {
      unavailableQueries.add(commandId);
    },
    wasCommandQueried(commandId) {
      return queriedCommandIds.has(commandId);
    },
    sentCommandIds() {
      return [...sentCommandIds];
    },
    subscriptionCount() {
      return subscriptionCount;
    },
    executionCount(commandId) {
      return executions.get(commandId) ?? 0;
    },
    gateInitial() {
      const entered = deferred();
      const release = deferred();
      initialGate = { entered, release };
      return { entered: entered.promise, release: () => release.resolve() };
    },
    holdNextAck() {
      const accepted = deferred();
      const release = deferred();
      nextAck = { accepted, release };
      return { accepted: accepted.promise, release: (options) => release.resolve(options) };
    },
    dispose() {
      gateway.dispose();
      frames.dispose();
      runtime.dispose();
      runtimeLifecycle.dispose();
    },
  };
}
