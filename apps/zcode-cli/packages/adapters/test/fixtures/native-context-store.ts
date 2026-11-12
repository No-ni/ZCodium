import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import {
  createMessageId,
  createPartId,
  createProjectId,
  createSessionId,
  NativeContextStoreConflictError,
  type CreateSessionInput,
  type MessageWithParts,
  type NativeContextStoreConflictReason,
  type SessionId,
} from "@zcode/contracts";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import {
  createRecommendedNativeContextConfiguration,
  emptyNativeContextImageMeasurement,
  type NativeContextObservation,
  type NativeContextOperation,
  type NativeContextSource,
  type NativeContextStoredState,
} from "@zcode/shared/native-context-compression";
import type { SqliteSessionStoreOptions } from "../../src/storage/session-store/options.js";

export const SESSION_ID = createSessionId("native-context-fixture");
export const PARENT_ID = createSessionId("native-context-parent");
export const CHILD_ID = createSessionId("native-context-child");
export const HASH = "1".repeat(64);

export function sessionInput(id = SESSION_ID): CreateSessionInput {
  return {
    id,
    projectID: createProjectId("native-context-project"),
    slug: id,
    directory: "fixture-workspace",
    path: "fixture-workspace",
    title: "合成上下文存储任务",
    version: "3.17.1",
    time: { created: 1, updated: 1 },
  };
}

export async function memoryStore(t: TestContext, options: SqliteSessionStoreOptions = {}) {
  const store = await createSqliteSessionStore({ ...options, dbPath: ":memory:" });
  t.after(() => store.close());
  return store;
}

export function state(overrides: Partial<NativeContextStoredState> = {}): NativeContextStoredState {
  return {
    version: 1,
    policy: { ...createRecommendedNativeContextConfiguration(), policyVersion: 1 },
    revision: 0,
    generation: 0,
    historyVersion: "history-0",
    compactBoundaryId: "segment-0",
    requestSeq: 0,
    kernel: {},
    sources: [],
    imageReceipts: [],
    lastCheckedHistoryVersion: null,
    lastMaintenanceTokens: 0,
    roundsSinceMaintenance: 0,
    estimateHoldRounds: 0,
    ...overrides,
  };
}

export function observation(
  id = "point-0",
  overrides: Partial<NativeContextObservation> = {},
): NativeContextObservation {
  return {
    id,
    logicalRequestId: "request-" + id,
    usageRecordRef: "usage-" + id,
    attemptIndex: 0,
    requestSeq: 0,
    purpose: "main",
    status: "prepared",
    generation: 0,
    historyVersion: "history-0",
    policyVersion: 1,
    segmentId: "segment-0",
    estimatorVersion: "native-context-v1",
    measurementScope: "complete",
    model: { providerId: "fixture-provider", modelId: "fixture-model" },
    inputBudget: 10000,
    contextWindow: 12000,
    startTokens: 8000,
    targetTokens: 6000,
    beforeEstimate: 9000,
    afterEstimate: 6000,
    textBeforeEstimate: 9000,
    textAfterEstimate: 6000,
    actualInputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreateTokens: null,
    visionTokens: null,
    images: emptyNativeContextImageMeasurement(),
    operationIds: [],
    origin: "own",
    createdAt: 10,
    completedAt: null,
    ...overrides,
  };
}

export function operation(
  operationId = "operation-0",
  overrides: Partial<NativeContextOperation> = {},
): NativeContextOperation {
  return {
    operationId,
    commandId: null,
    kind: "summary",
    trigger: "automatic",
    status: "preparing",
    generation: 0,
    policyVersion: 1,
    historyVersion: "history-0",
    segmentId: "segment-0",
    createdAt: 10,
    completedAt: null,
    elapsedMs: null,
    beforeEstimate: 9000,
    afterEstimate: null,
    model: null,
    observationIds: [],
    blockIds: [],
    sources: [],
    summary: "",
    reason: null,
    origin: "own",
    ...overrides,
  };
}

export function message(sessionID: SessionId, suffix = "message"): MessageWithParts {
  const messageID = createMessageId(String(sessionID) + "-" + suffix);
  return {
    info: { id: messageID, sessionID, role: "user", agent: "build", time: { created: 10 } },
    parts: [
      {
        id: createPartId(String(messageID) + "-part"),
        messageID,
        sessionID,
        type: "text",
        text: "合成测试原文",
        time: { start: 10, end: 10 },
      },
    ],
  };
}

export function source(
  item: MessageWithParts,
  overrides: Partial<NativeContextSource> = {},
): NativeContextSource {
  return {
    rawId: "raw-" + item.info.id,
    ref: "ref-" + item.info.id,
    messageId: item.info.id,
    partId: item.parts[0]!.id,
    entryIndex: 0,
    imageIndex: null,
    kind: "text",
    sourceKind: "other",
    contentHash: HASH,
    artifactUri: null,
    originalAvailable: true,
    originalBytes: null,
    width: null,
    height: null,
    firstSeenAt: 10,
    tokenSnapshot: 10,
    ...overrides,
  };
}

export function conflict(reason: NativeContextStoreConflictReason) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof NativeContextStoreConflictError);
    assert.equal(error.code, "native_context_store_conflict");
    assert.equal(error.reason, reason);
    assert.equal(error.message, "Native context storage conflict");
    return true;
  };
}
