import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import {
  createPartId,
  ModelTransportKind,
  type ModelUsageRecord,
  type SessionEvent,
  type ToolPart,
} from "@zcode/contracts";
import type { NativeContextStoredState } from "@zcode/shared/native-context-compression";
import { createNativeAttemptTracker } from "../src/runtime/native-context-compression/attempts.js";
import { nativeProjectionForRequest } from "../src/runtime/native-context-compression/safe-point.js";
import { prepareRuntimeProviderRequest } from "../src/runtime/helpers/runtime-provider-request-messages.js";
import { recordModelUsageFact } from "../src/runtime/model-usage-observability/index.js";
import { block, CHILD } from "./native-context-boundary-fixture.js";
import { maintenanceFixture } from "./native-context-maintenance-fixture.js";
import { kernelOf, writeNativeState } from "../src/runtime/native-context-compression/state.js";
import {
  finishNativeOperation,
  nativeOperation,
} from "../src/runtime/native-context-compression/records.js";
import { hydrateMessageHistoryFromSession } from "../src/agent/session-history-hydrator.js";
import { syncNativeSources } from "../src/runtime/native-context-compression/sources.js";
import { nativeCountTokens } from "../src/runtime/native-context-compression/measurements.js";

export type ProjectionFixture = Awaited<ReturnType<typeof maintenanceFixture>>;

export function configureAutomatic(state: NativeContextStoredState): void {
  state.policy.mode = "auto";
  state.policy.parameters.trigger.start = { kind: "percent", value: 10 };
  state.policy.parameters.trigger.target = { kind: "percent", value: 5 };
  state.policy.parameters.trigger.opportunisticPercent = 5;
  state.policy.parameters.trigger.waitForUsageSample = false;
}

export function projection(f: ProjectionFixture, entries = f.safePoint().entries) {
  const result = nativeProjectionForRequest(f.host, entries, f.model, []);
  assert.ok(result.comparison);
  return result;
}

/** 真正走当前 statusSink、tracker 和 SQLite；不以手工清 pending 模拟首轮消费。 */
export async function completeMain(
  f: ProjectionFixture,
  requestId: string,
  entries = f.safePoint().entries,
) {
  const prepared = projection(f, entries);
  const comparison = prepared.comparison!;
  const request = prepareRuntimeProviderRequest(f.host, {
    entries: prepared.entries,
    model: f.model,
    tools: [],
    registry: f.host.registry,
  }).request;
  const events: SessionEvent[] = [];
  const facts: ModelUsageRecord[] = [];
  const usage = { inputTokens: 50, outputTokens: 5, cacheReadTokens: 0 };
  const startedAt = Date.now();
  const tracker = createNativeAttemptTracker(f.host, {
    comparison,
    policy: comparison.policy,
    model: f.model,
    beforeMessages: comparison.baselineMessages,
    afterMessages: request.messages,
    tools: request.tools,
    maxOutputTokens: 1024,
    sentImages: [],
    imageChanges: { omittedRefs: [], foldedRefs: [], resizedRefs: [], restoredRefs: [] },
    traceContext: f.host.rootTraceContext,
    anchorMessageId: f.messages[1]!.info.id,
  });
  const sink = f.host.createModelStatusSink(f.host.rootTraceContext, events, {
    persist: false,
    onStatus: tracker.onStatus,
  });
  const base = {
    requestId,
    providerId: f.model.providerId,
    modelId: f.model.modelId,
    transport: ModelTransportKind.Http,
    attempt: 1,
    maxAttempts: 1,
    traceId: f.host.rootTraceContext.traceId,
    spanId: f.host.rootTraceContext.spanId,
  };
  await sink.publish({
    ...base,
    type: "model_request_started",
    timestamp: new Date(startedAt).toISOString(),
  });
  await sink.publish({
    ...base,
    type: "model_request_completed",
    timestamp: new Date().toISOString(),
    durationMs: 1,
    usage,
  });
  await tracker.finish({ status: "completed", usage });
  await recordModelUsageFact(f.host, {
    events,
    model: f.model,
    networkEventStartIndex: 0,
    querySource: "main_turn",
    startedAt,
    status: "completed",
    traceContext: f.host.rootTraceContext,
    result: { text: "synthetic main response", finishReason: "stop", usage },
    onModelUsage: (fact) => {
      facts.push(structuredClone(fact));
    },
  });
  return { prepared, request, facts, rows: await f.observations("main") };
}

export async function seededProjection(t: TestContext) {
  const f = await maintenanceFixture(t);
  const sources = f.owner.state!.sources;
  const first = sources.find((source) => source.messageId === f.messages[0]!.info.id)!;
  const future = sources.find((source) => source.messageId === f.messages[2]!.info.id)!;
  const producer = finishNativeOperation(
    nativeOperation(f.owner.state!, {
      kind: "summary",
      trigger: "manual",
      sources: [first],
      anchorMessageId: first.messageId,
    }),
    "completed",
  );
  producer.blockIds = ["kept"];
  const discarded = finishNativeOperation(
    nativeOperation(f.owner.state!, {
      kind: "summary",
      trigger: "manual",
      sources: [future],
      anchorMessageId: future.messageId,
    }),
    "completed",
  );
  discarded.blockIds = ["future"];
  await writeNativeState(
    f.owner,
    (next) => {
      const kernel = kernelOf(next);
      kernel.compression.blocks = [block("kept", [first.rawId]), block("future", [future.rawId])];
      kernel.views = {
        [first.rawId]: {
          kind: "reference",
          text: "kept view",
          policyVersion: next.policy.policyVersion,
        },
        [future.rawId]: {
          kind: "reference",
          text: "future view",
          policyVersion: next.policy.policyVersion,
        },
      };
      kernel.projectionOperations = {
        blocks: { kept: producer.operationId, future: discarded.operationId },
        views: { [first.rawId]: producer.operationId, [future.rawId]: discarded.operationId },
      };
    },
    { operations: [producer, discarded] },
  );
  return { ...f, first, future, producer, discarded };
}

export function forkMaps(f: ProjectionFixture, keep: number) {
  const messages = f.messages.slice(0, keep);
  return {
    childSessionId: String(CHILD),
    messageIds: new Map(
      messages.map((item) => [String(item.info.id), `msg_child_${item.info.id}`]),
    ),
    partIds: new Map(
      messages.flatMap((item) =>
        item.parts.map((part) => [String(part.id), `part_child_${part.id}`]),
      ),
    ),
    toolCallIds: new Map<string, string>(),
  };
}

/** 真正的 completed ToolPart 先落 SQLite，再经直播恢复规范建立 raw/part 身份。 */
export async function appendProjectionTool(f: ProjectionFixture, text: string): Promise<ToolPart> {
  const message = f.messages[1]!;
  const tool: ToolPart = {
    id: createPartId("projection-completed-tool"),
    type: "tool",
    callID: "projection-real-tool-call",
    tool: "FixtureOutput",
    sessionID: message.info.sessionID,
    messageID: message.info.id,
    state: {
      status: "completed",
      input: {},
      output: text,
      title: "synthetic result",
      metadata: {},
      time: { start: 11, end: 12 },
    },
  };
  message.parts.push(tool);
  await f.store.commitMessageBundle({ sessionID: message.info.sessionID, messages: [message] });
  f.host.messageHistory.reset();
  await hydrateMessageHistoryFromSession({ history: f.host.messageHistory, messages: f.messages });
  await writeNativeState(f.owner, (next) =>
    syncNativeSources(next, f.safePoint().entries, nativeCountTokens),
  );
  return tool;
}
