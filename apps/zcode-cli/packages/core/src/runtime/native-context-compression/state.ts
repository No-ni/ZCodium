import { createInitialState, activeBlocks, type CompressionState } from "acp-kernel";
import { SessionEventType } from "@zcode/contracts";
import {
  createRecommendedNativeContextConfiguration,
  nativeContextConfigurationSchema,
  type NativeContextConfiguration,
  type NativeContextStoredState,
  type NativeContextStatus,
  type NativeContextOperation,
  type NativeContextOperationSummary,
  type NativeContextObservation,
} from "@zcode/shared/native-context-compression";
import type { AgentRuntimeInternal } from "../internal.js";
import { NativeContextRuntimeError } from "./contract.js";
import { historyVersionOf } from "./identity.js";
import { resolvedNativeToolProtection } from "./tool-protection.js";

export interface NativeKernelData extends Record<string, unknown> {
  compression: CompressionState;
  /** 回退可删除未来 ref，但不得重新把已分配编号绑定到另一条消息。 */
  refHighWaterIndex?: number;
  views: Record<
    string,
    {
      kind: "reference" | "simplified" | "distilled";
      text: string;
      policyVersion: number;
    }
  >;
  /** 生效块/发送视图与生产操作同 CAS 提交；只在实际投影时关联，不以 pending 推断。 */
  projectionOperations?: {
    blocks: Record<string, string>;
    views: Record<string, string>;
  };
  omittedReasoningIds?: string[];
  imageViews?: Record<
    string,
    {
      artifactUri: string;
      mediaType: string;
      policyHash: string;
      representationHash: string;
      bytes: number;
    }
  >;
  omittedImageRefs?: string[];
  policyCommands?: Record<
    string,
    {
      expectedVersion: number;
      configurationHash: string;
      policyVersion: number;
    }
  >;
}
export interface NativeContextStateOwner {
  runtime: AgentRuntimeInternal;
  state: NativeContextStoredState | null;
  phase: "idle" | "compressing";
  inputBudget: number | null;
  lastObservation: NativeContextObservation | null;
  lastOperation: NativeContextOperationSummary | null;
  serial: Promise<unknown>;
  pendingOperationIds: string[];
  restoring: boolean;
  initialization?: Promise<void>;
  cancellation?: AbortController;
  maintenanceStartedAt?: number;
  commandResults?: Map<string, Promise<import("./contract.js").NativeContextOutcome>>;
  restoreImageRefs?: Set<string>;
}
const owners = new WeakMap<AgentRuntimeInternal, NativeContextStateOwner>();
export function nativeOwner(runtime: AgentRuntimeInternal): NativeContextStateOwner {
  let owner = owners.get(runtime);
  if (!owner) {
    owner = {
      runtime,
      state: null,
      phase: "idle",
      inputBudget: null,
      lastObservation: null,
      lastOperation: null,
      serial: Promise.resolve(),
      pendingOperationIds: [],
      restoring: false,
    };
    owners.set(runtime, owner);
  }
  return owner;
}
export async function ensureNativeState(owner: NativeContextStateOwner): Promise<void> {
  if (owner.state) {
    if (owner.state.generation !== owner.runtime.branchGeneration)
      throw new NativeContextRuntimeError("conflict", "generation");
    return;
  }
  owner.initialization ??= (async () => {
    const runtime = owner.runtime;
    const store = runtime.sessionStore;
    if (!store?.getNativeContextState || !store.commitNativeContext) {
      throw new NativeContextRuntimeError("unavailable", "unsupported-store");
    }
    if (!runtime.sessionPersisted)
      throw new NativeContextRuntimeError("unavailable", "deferred-session");
    const stored = await store.getNativeContextState(runtime.sessionId);
    if (stored) {
      kernelOf(stored);
      owner.state = stored;
    } else {
      const state = initialNativeState(
        runtime,
        owner.restoring
          ? createRecommendedNativeContextConfiguration("manual")
          : (runtime.config.nativeContextCompression ??
              createRecommendedNativeContextConfiguration("auto")),
      );
      await store.commitNativeContext(runtime.sessionId, {
        expectedRevision: null,
        expectedGeneration: runtime.branchGeneration,
        state,
      });
      owner.state = state;
    }
    const [observations, operations] = await Promise.all([
      store.listNativeContextObservations?.(runtime.sessionId, {
        limit: 1,
        purpose: "main",
      }),
      store.listNativeContextOperations?.(runtime.sessionId, { limit: 1 }),
    ]);
    owner.lastObservation = observations?.items[0] ?? null;
    owner.lastOperation = operations?.items[0] ?? null;
  })();
  try {
    await owner.initialization;
  } catch (error) {
    owner.initialization = undefined;
    throw error;
  }
}
export function kernelOf(state: NativeContextStoredState): NativeKernelData {
  const data = state.kernel as NativeKernelData;
  if (
    !data.compression ||
    !Array.isArray(data.compression.blocks) ||
    !data.compression.messageRefs ||
    !data.compression.tokenSnapshot ||
    !data.views
  )
    throw new NativeContextRuntimeError("invalid-state", "kernel");
  return data;
}
export function initialNativeState(
  runtime: AgentRuntimeInternal,
  configuration?: NativeContextConfiguration,
): NativeContextStoredState {
  const config = nativeContextConfigurationSchema.parse(
    configuration ?? createRecommendedNativeContextConfiguration("manual"),
  );
  return {
    version: 1,
    policy: { ...config, policyVersion: 0 },
    revision: 0,
    generation: runtime.branchGeneration,
    historyVersion: historyVersionOf(runtime.messageHistory.borrowReadOnlyRuntimeEntries()),
    compactBoundaryId: "initial",
    requestSeq: 0,
    kernel: {
      compression: createInitialState(),
      views: {},
    } satisfies NativeKernelData,
    sources: [],
    imageReceipts: [],
    lastCheckedHistoryVersion: null,
    lastMaintenanceTokens: 0,
    roundsSinceMaintenance: 0,
    estimateHoldRounds: 0,
  };
}
export function operationSummary(operation: NativeContextOperation): NativeContextOperationSummary {
  const { sources: _sources, summary: _summary, ...summary } = operation;
  return summary;
}
export function nativeStatus(owner: NativeContextStateOwner): NativeContextStatus {
  const state =
    owner.state ??
    initialNativeState(
      owner.runtime,
      owner.restoring
        ? undefined
        : (owner.runtime.config.nativeContextCompression ??
            createRecommendedNativeContextConfiguration("auto")),
    );
  const kernel = kernelOf(state);
  const unavailableReason = !owner.runtime.sessionStore?.commitNativeContext
    ? "unsupported-store"
    : owner.phase === "compressing"
      ? "busy"
      : !owner.runtime.sessionModelSelection
        ? "no-model"
        : null;
  const executionId = owner.runtime.activeForegroundExecution?.foregroundExecutionId;
  return {
    policy: structuredClone(state.policy),
    revision: state.revision,
    generation: state.generation,
    historyVersion: state.historyVersion,
    // 原因：compact 后最后主请求仍属于旧段；当前段必须直接投影已提交边界。
    currentSegmentId: state.compactBoundaryId,
    phase: owner.phase,
    // 原因：preparing 仅代表入队；Stop 必须绑定已开始的维护和 Runtime 原有执行域，不能误停后续命令。
    ...(owner.phase === "compressing" &&
    owner.cancellation &&
    executionId &&
    owner.maintenanceStartedAt !== undefined
      ? {
          activeMaintenance: {
            foregroundExecutionId: executionId,
            startedAt: owner.maintenanceStartedAt,
          },
        }
      : {}),
    inputBudget: owner.inputBudget,
    effectiveBlocks: activeBlocks(kernel.compression).length,
    referencedOutputs: Object.values(kernel.views).filter((view) => view.kind === "reference")
      .length,
    resolvedToolProtection: resolvedNativeToolProtection(
      owner.runtime.registry?.list() ?? [],
      state.policy,
    ),
    unavailableReason,
    lastObservation: owner.lastObservation,
    lastOperation: owner.lastOperation,
  };
}
export async function publishNativeStatus(owner: NativeContextStateOwner): Promise<void> {
  if (!owner.runtime.sessionPersisted) return;
  const trace = owner.runtime.rootTraceContext;
  await owner.runtime.appendEvent(
    owner.runtime.createEvent(
      SessionEventType.NativeContextCompressionUpdated,
      nativeStatus(owner),
      trace,
    ),
    trace,
  );
}
/** 唯一串行写入口。模型 IO 不占此锁；最终提交还需检查冻结边界。 */
export function writeNativeState(
  owner: NativeContextStateOwner,
  change: (candidate: NativeContextStoredState) => void,
  facts: {
    operations?: NativeContextOperation[];
    observations?: NativeContextObservation[];
  } = {},
  onCommitted?: () => void,
): Promise<void> {
  const result = owner.serial.then(async () => {
    const current = owner.state;
    if (!current) throw new NativeContextRuntimeError("unavailable", "recovering");
    const candidate = structuredClone(current);
    change(candidate);
    candidate.revision = current.revision + 1;
    const store = owner.runtime.sessionStore;
    if (!store?.commitNativeContext)
      throw new NativeContextRuntimeError("unavailable", "unsupported-store");
    await store.commitNativeContext(owner.runtime.sessionId, {
      expectedRevision: current.revision,
      expectedGeneration: owner.runtime.branchGeneration,
      state: candidate,
      ...facts,
    });
    owner.state = candidate;
    const operation = facts.operations?.at(-1);
    const observation = facts.observations?.findLast((item) => item.purpose === "main");
    if (operation) owner.lastOperation = operationSummary(operation);
    if (observation && observation.purpose === "main") owner.lastObservation = observation;
    onCommitted?.();
    await publishNativeStatus(owner);
  });
  owner.serial = result.catch(() => undefined);
  return result;
}
