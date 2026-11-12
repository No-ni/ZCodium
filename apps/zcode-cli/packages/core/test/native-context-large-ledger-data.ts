import { createHash } from "node:crypto";
import {
  allocateBlockId,
  allocateRunId,
  assignRefs,
  createInitialState,
  type CompressionState,
  type CoreMessage,
} from "acp-kernel";
import {
  createMessageId,
  createProjectId,
  createSessionId,
  type CreateSessionInput,
  type MessageWithParts,
} from "@zcode/contracts";
import {
  createRecommendedNativeContextConfiguration,
  emptyNativeContextImageMeasurement,
  nativeContextCommitSchema,
  type NativeContextObservation,
  type NativeContextOperation,
  type NativeContextSource,
} from "@zcode/shared/native-context-compression";
import {
  nativeContextLedgerSeedManifestSchema,
  type NativeContextLedgerSeedManifest,
} from "../../../../../packages/desktop/test/e2e/helpers/native-context-compression/ledger-fixture-contract.js";
import { providerModelUsageIdentity } from "../src/runtime/model-usage-observability/index.js";
import { createNativeContextLedgerMessage as canonicalMessage } from "./native-context-large-ledger-message.js";

const MAIN_COUNT = 2970;
const GAPS = [
  { first: 500, last: 520 },
  { first: 2300, last: 2340 },
];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const tokens = (value: string) => Math.ceil(value.length / 4);

export interface NativeContextLedgerDataOptions {
  namespace: string;
  sandboxRoot: string;
  homeDir: string;
  workspacePath: string;
  dbPath: string;
  model: NativeContextObservation["model"];
  version: string;
  createdAt?: number;
}

function requestFact(
  options: NativeContextLedgerDataOptions,
  seq: number,
  purpose: NativeContextObservation["purpose"],
  historyVersion: string,
  createdAt: number,
): NativeContextObservation {
  const querySource = purpose === "main" ? "main_turn" : `native_context_${purpose}`;
  const identity = providerModelUsageIdentity(querySource, {
    requestId: `${options.namespace}-${purpose}-${seq}`,
    attempt: 1,
  });
  const before = 20000 + seq * 10;
  const after = before - 1000;
  return {
    ...identity,
    usageRecordRef: identity.id,
    anchorMessageId: createMessageId(`${options.namespace}-assistant-${seq}`),
    requestSeq: seq,
    purpose,
    status: "completed",
    generation: 0,
    historyVersion,
    policyVersion: 0,
    segmentId: "initial",
    estimatorVersion: "native-context-v1",
    measurementScope: "complete",
    model: options.model,
    inputBudget: 195000,
    contextWindow: 200000,
    startTokens: 136500,
    targetTokens: 97500,
    beforeEstimate: before,
    afterEstimate: after,
    textBeforeEstimate: before,
    textAfterEstimate: after,
    actualInputTokens: after,
    outputTokens: 100 + (seq % 20),
    cacheReadTokens: Math.floor(after / 4),
    cacheCreateTokens: seq % 5,
    visionTokens: null,
    images: emptyNativeContextImageMeasurement(),
    operationIds: [],
    origin: "own",
    createdAt,
    completedAt: createdAt + 1,
  };
}

function mainFact(...args: Parameters<typeof requestFact>): NativeContextObservation {
  const fact = requestFact(...args);
  const seq = fact.requestSeq;
  if (seq === 1234) {
    fact.beforeEstimate = fact.textBeforeEstimate = 195000;
    fact.afterEstimate = fact.textAfterEstimate = 190000;
    fact.actualInputTokens = 185000;
  }
  if (seq === 1777) {
    fact.beforeEstimate = fact.textBeforeEstimate = 10;
    fact.afterEstimate = fact.textAfterEstimate = fact.actualInputTokens = 0;
    fact.cacheReadTokens = fact.cacheCreateTokens = 0;
  }
  if (seq === 1500) {
    fact.beforeEstimate = fact.textBeforeEstimate = 45000;
    fact.afterEstimate = fact.textAfterEstimate = fact.actualInputTokens = 46000;
  }
  if (GAPS.some((gap) => seq >= gap.first && seq <= gap.last)) {
    fact.actualInputTokens =
      fact.outputTokens =
      fact.cacheReadTokens =
      fact.cacheCreateTokens =
        null;
  }
  return fact;
}

function maintenanceEvent(
  options: NativeContextLedgerDataOptions,
  index: number,
  seq: number,
  historyVersion: string,
  createdAt: number,
  sources: NativeContextSource[],
  compression: CompressionState,
) {
  const statuses = ["completed", "error", "cancelled", "no-benefit"] as const;
  const status = statuses[index % statuses.length]!;
  const operationId = `${options.namespace}-operation-${index + 1}`;
  const decision = requestFact(options, seq, "decision", historyVersion, createdAt);
  const maintenance = requestFact(options, seq, "maintenance", historyVersion, createdAt + 2);
  for (const observation of [decision, maintenance]) {
    observation.operationIds = [operationId];
    observation.beforeEstimate =
      observation.afterEstimate =
      observation.actualInputTokens =
      observation.textBeforeEstimate =
      observation.textAfterEstimate =
        observation.purpose === "decision" ? 60 : 800;
    observation.outputTokens = observation.purpose === "decision" ? 8 : 90;
    observation.cacheReadTokens = observation.cacheCreateTokens = 0;
  }
  if (status === "error" || status === "cancelled") maintenance.status = status;
  const chosen = sources.slice(index * 4, index * 4 + 4);
  const summary = status === "completed" ? `合成摘要 ${index + 1}：早期两轮已完成历史。` : "";
  const blockIds: string[] = [];
  if (status === "completed") {
    const blockId = allocateBlockId(compression);
    const rawIds = chosen.map((source) => source.rawId);
    blockIds.push(blockId);
    compression.blocks.push({
      blockId,
      runId: allocateRunId(compression),
      tier: 1,
      summary,
      directMessageIds: rawIds,
      effectiveMessageIds: rawIds,
      directBlockIds: [],
      compressedTokens: tokens(summary),
      createdAt,
      survivedCount: 0,
      generation: "young",
      active: true,
    });
    compression.stats.compressionCount += 1;
    compression.stats.tokensCompressed += chosen.reduce(
      (sum, source) => sum + source.tokenSnapshot,
      0,
    );
  }
  const operation: NativeContextOperation = {
    operationId,
    commandId: `${options.namespace}-manual-${index + 1}`,
    anchorRequestSeq: seq,
    anchorMessageId: maintenance.anchorMessageId,
    kind: "summary",
    trigger: "manual",
    status,
    generation: 0,
    policyVersion: 0,
    historyVersion,
    segmentId: "initial",
    createdAt,
    completedAt: createdAt + 4,
    elapsedMs: 4,
    beforeEstimate: 800,
    afterEstimate: status === "completed" ? 90 : status === "no-benefit" ? 850 : null,
    model: options.model,
    observationIds: [decision.id, maintenance.id],
    blockIds,
    sources: chosen.map((source) => ({
      ref: source.ref,
      messageId: source.messageId,
      partId: source.partId,
      imageIndex: null,
      kind: "text",
      originalAvailable: true,
    })),
    summary,
    reason: status === "completed" ? "none" : status === "error" ? "model-error" : status,
    origin: "own",
  };
  return { operation, decision, maintenance };
}

/** 使用当前公共内核/计费 identity；前缀 hash 与真实 hydration 在定向测试中核对。 */
export function createNativeContextLargeLedgerData(options: NativeContextLedgerDataOptions) {
  const createdAt = options.createdAt ?? Date.now() - MAIN_COUNT * 1000;
  const sessionID = createSessionId(options.namespace);
  const messages: MessageWithParts[] = [];
  const cores: CoreMessage[] = [];
  const observations: NativeContextObservation[] = [];
  const operations: NativeContextOperation[] = [];
  const compression = createInitialState();
  const prefix = createHash("sha256").update("[");
  const historyAfter = new Map<number, string>();
  const addMessage = (message: MessageWithParts) => {
    const text = message.parts[0]!.type === "text" ? message.parts[0]!.text : "";
    const core: CoreMessage = {
      id: `${message.info.id}#e0`,
      role: message.info.role,
      contentType: "text",
      text,
    };
    if (messages.length) prefix.update(",");
    prefix.update(
      JSON.stringify({
        id: core.id,
        role: core.role,
        text,
        ...(core.role === "assistant" ? { calls: [] } : {}),
        images: [],
      }),
    );
    messages.push(message);
    cores.push(core);
    return prefix.copy().update("]").digest("hex");
  };
  for (let seq = 1; seq <= MAIN_COUNT; seq++) {
    const beforeHistory = addMessage(
      canonicalMessage(options, seq, "user", createdAt + seq * 1000),
    );
    observations.push(mainFact(options, seq, "main", beforeHistory, createdAt + seq * 1000 + 10));
    historyAfter.set(
      seq,
      addMessage(canonicalMessage(options, seq, "assistant", createdAt + seq * 1000 + 20)),
    );
  }
  compression.messageRefs = assignRefs(cores, {
    existing: compression.messageRefs,
    nextIndex: 1,
  }).map;
  const sources: NativeContextSource[] = cores.map((core, index) => {
    const message = messages[index]!;
    const ref = compression.messageRefs.byRaw[core.id]!;
    const tokenSnapshot = tokens(core.text ?? "");
    compression.tokenSnapshot[ref] = tokenSnapshot;
    return {
      rawId: core.id,
      ref,
      messageId: message.info.id,
      partId: message.parts[0]!.id,
      entryIndex: 0,
      imageIndex: null,
      kind: "text",
      sourceKind: "other",
      contentHash: hash(core.text ?? ""),
      artifactUri: null,
      originalAvailable: true,
      originalBytes: null,
      width: null,
      height: null,
      firstSeenAt: message.info.time.created,
      tokenSnapshot,
    };
  });
  for (let index = 0; index < 15; index++) {
    const seq = 190 * (index + 1);
    const event = maintenanceEvent(
      options,
      index,
      seq,
      historyAfter.get(seq)!,
      createdAt + seq * 1000 + 30,
      sources,
      compression,
    );
    operations.push(event.operation);
    observations.push(event.decision, event.maintenance);
    if (event.operation.status === "completed")
      observations[seq]!.operationIds.push(event.operation.operationId);
  }
  observations.sort((left, right) => left.createdAt - right.createdAt);
  const historyVersion = historyAfter.get(MAIN_COUNT)!;
  const commit = nativeContextCommitSchema.parse({
    expectedRevision: null,
    expectedGeneration: 0,
    state: {
      version: 1,
      policy: { ...createRecommendedNativeContextConfiguration("manual"), policyVersion: 0 },
      revision: 0,
      generation: 0,
      historyVersion,
      compactBoundaryId: "initial",
      requestSeq: MAIN_COUNT,
      kernel: { compression, views: {}, refHighWaterIndex: sources.length },
      sources,
      imageReceipts: [],
      lastCheckedHistoryVersion: historyVersion,
      lastMaintenanceTokens: 0,
      roundsSinceMaintenance: 0,
      estimateHoldRounds: 0,
    },
    operations,
    observations,
  });
  const main = commit.observations!.filter((fact) => fact.purpose === "main");
  const at = (seq: number) => main.find((fact) => fact.requestSeq === seq)!;
  const title = "NCTX-58 · 3000 条合成上下文记录";
  const manifest: NativeContextLedgerSeedManifest = nativeContextLedgerSeedManifestSchema.parse({
    version: 1,
    caseId: "NCTX-58",
    synthetic: true,
    namespace: options.namespace,
    sessionId: sessionID,
    title,
    model: options.model,
    sandboxRoot: options.sandboxRoot,
    homeDir: options.homeDir,
    workspacePath: options.workspacePath,
    dbPath: options.dbPath,
    revision: 0,
    generation: 0,
    historyVersion,
    currentSegmentId: "initial",
    counts: {
      observations: 3000,
      main: MAIN_COUNT,
      maintenance: 15,
      decision: 15,
      operations: 15,
      messages: MAIN_COUNT * 2,
    },
    sentinels: {
      first: at(1),
      last: at(MAIN_COUNT),
      peak: at(1234),
      zero: at(1777),
      increase: at(1500),
      selected: at(1111),
      unknown: at(510),
      event: at(191),
    },
    unknownGaps: GAPS,
    eventPointIds: main.filter((fact) => fact.operationIds.length).map((fact) => fact.id),
    operations: commit.operations!.map(
      ({ sources: _sources, summary: _summary, ...operation }) => operation,
    ),
  });
  const session: CreateSessionInput = {
    id: sessionID,
    projectID: createProjectId(`${options.namespace}-cli`),
    taskType: "interactive",
    slug: options.namespace,
    directory: options.workspacePath,
    path: options.workspacePath,
    title,
    titleSource: "custom",
    version: options.version,
    time: { created: createdAt, updated: createdAt + MAIN_COUNT * 1000 + 21 },
  };
  return { session, messages, commit, manifest };
}
