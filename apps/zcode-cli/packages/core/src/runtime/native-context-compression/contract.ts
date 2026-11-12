import type {
  Model,
  ModelInputMessage,
  ModelToolContract,
  ModelSelection,
  ModelUsage,
  TraceContext,
} from "@zcode/contracts";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type {
  NativeContextConfiguration,
  NativeContextPolicy,
  NativeContextStatus,
  NativeContextOperation,
  NativeContextObservation,
  NativeContextImageReceipt,
  NativeContextPage,
  NativeContextPageRequest,
  NativeContextOperationSummary,
  NativeContextOperationDetail,
  NativeContextRecordRequest,
  NativeContextSourceRequest,
  NativeContextSourcePage,
  NativeContextImageRequest,
  NativeContextImage,
} from "@zcode/shared/native-context-compression";

export type * from "@zcode/shared/native-context-compression";
export interface NativeContextSafePoint {
  entries: readonly RuntimeMessageEntry[];
  model: Model;
  tools: readonly ModelToolContract[];
  signal?: AbortSignal;
  traceContext: TraceContext;
}
/** 同一请求的本地对照。内容只在 runtime 内存中，绝不进入 snapshot/日志。 */
export interface NativeContextRequestComparison {
  baselineMessages: ModelInputMessage[];
  baselineLatestRealUserMessageIndex?: number;
  baselineEntries: readonly RuntimeMessageEntry[];
  historyVersion: string;
  generation: number;
  policyVersion: number;
  policy: NativeContextPolicy;
  segmentId: string;
  operationIds: string[];
}
export interface NativeContextPreparedAttempt {
  logicalRequestId: string;
  comparison: NativeContextRequestComparison;
  model: Model;
  beforeMessages: ModelInputMessage[];
  /** 原图对照无法通过同一硬容量 gate 时为 false；不能将未知 before 当成 0。 */
  baselineMeasurable?: boolean;
  afterMessages: ModelInputMessage[];
  tools: readonly ModelToolContract[];
  maxOutputTokens: number;
  startedAt: number;
  sentImages: NativeContextImageReceipt[];
  imageChanges: {
    omittedRefs: string[];
    foldedRefs: string[];
    resizedRefs: string[];
    restoredRefs: string[];
  };
}
export interface NativeContextAttemptTrackerInput extends Omit<
  NativeContextPreparedAttempt,
  "startedAt" | "logicalRequestId"
> {
  policy: NativeContextPolicy;
  traceContext: TraceContext;
  purpose?: NativeContextObservation["purpose"];
  querySource?: string;
  operationId?: string;
  anchorMessageId?: string | null;
}
export interface NativeContextAttemptOutcome {
  status: "completed" | "error" | "cancelled";
  usage?: ModelUsage;
  error?: unknown;
}
export interface NativeContextAttemptTracker {
  onStatus(event: import("@zcode/contracts").ModelNetworkStatusEvent): Promise<void>;
  finish(outcome: NativeContextAttemptOutcome): Promise<void>;
  readonly successfulReceipts: NativeContextImageReceipt[];
  readonly observationIds: readonly string[];
}
export interface NativeContextPolicyInput {
  configuration: NativeContextConfiguration;
  expectedPolicyVersion: number;
}
export interface NativeContextMaintenanceInput {
  model: ModelSelection;
  commandId: string;
  abortSignal: AbortSignal;
  traceContext: TraceContext;
}
export interface NativeContextRuntimeMethods {
  getNativeContextCompression(): Promise<NativeContextStatus>;
  configureNativeContextCompression(
    configuration: NativeContextConfiguration,
  ): Promise<NativeContextStatus>;
  setNativeContextPolicy(
    input: NativeContextPolicyInput & { commandId?: string; traceContext?: TraceContext },
  ): Promise<NativeContextStatus>;
  compressNativeContext(input: NativeContextMaintenanceInput): Promise<NativeContextOutcome>;
  listNativeContextObservations(
    input: Omit<NativeContextPageRequest, "sessionId">,
  ): Promise<NativeContextPage<NativeContextObservation>>;
  listNativeContextRecords(
    input: Omit<NativeContextPageRequest, "sessionId">,
  ): Promise<NativeContextPage<NativeContextOperationSummary>>;
  readNativeContextRecord(
    input: Omit<NativeContextRecordRequest, "sessionId">,
  ): Promise<NativeContextOperationDetail>;
  readNativeContextSource(
    input: Omit<NativeContextSourceRequest, "sessionId">,
  ): Promise<NativeContextSourcePage>;
  readNativeContextImage(
    input: Omit<NativeContextImageRequest, "sessionId">,
  ): Promise<NativeContextImage>;
}
export interface NativeContextOutcome {
  status: NativeContextStatus;
  operation: NativeContextOperation | null;
}
export interface NativeContextPendingObservation {
  operationId?: string;
  observation: NativeContextObservation;
}
export class NativeContextRuntimeError extends Error {
  constructor(
    readonly code:
      | "unavailable"
      | "busy"
      | "conflict"
      | "stale-view"
      | "invalid-range"
      | "invalid-state",
    readonly reason: string,
  ) {
    super(`native-context-${code}:${reason}`);
    this.name = "NativeContextRuntimeError";
  }
}
