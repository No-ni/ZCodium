import type { ModelNetworkStatusEvent, ModelUsage } from "@zcode/contracts";
import { providerModelUsageIdentity } from "../model-usage-observability/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type {
  NativeContextAttemptTracker,
  NativeContextAttemptTrackerInput,
  NativeContextAttemptOutcome,
} from "./contract.js";
import { ensureNativeState, nativeOwner } from "./state.js";
import {
  freezeNativeAttempt,
  nativeAttemptTime,
  prepareNativeAttempt,
  settleNativeAttempt,
} from "./attempt-facts.js";
import {
  nativeAttemptBoundary,
  persistNativeAttempt,
  reserveNativeRequestSeq,
  type NativeAttemptRecord,
} from "./attempt-persistence.js";

export function createNativeAttemptTracker(
  runtime: AgentRuntimeInternal,
  input: NativeContextAttemptTrackerInput,
): NativeContextAttemptTracker {
  const owner = nativeOwner(runtime);
  const frozen = freezeNativeAttempt(input);
  const records = new Map<string, NativeAttemptRecord>();
  const sentImages = input.sentImages;
  const noReceipts: typeof sentImages = [];
  let serial: Promise<unknown> = Promise.resolve();
  let finished = false;
  let receiptSuccess = false;
  const persist = (record: NativeAttemptRecord) =>
    persistNativeAttempt(owner, frozen, record, input.traceContext, input.operationId);
  const enqueue = (run: () => Promise<void>): Promise<void> => {
    const result = serial.then(run);
    serial = result.catch(() => undefined);
    return result;
  };
  const complete = async (
    record: NativeAttemptRecord,
    status: "completed" | "error" | "cancelled" | "obsolete",
    usage: ModelUsage | undefined,
    at: number,
  ) => {
    if (record.observation.status !== "prepared") return;
    record.observation = settleNativeAttempt(record.observation, status, usage, at);
    await persist(record);
  };
  const settlePendingSuccess = async (
    record: NativeAttemptRecord | undefined,
    usage?: ModelUsage,
  ) => {
    if (record?.terminal?.type === "model_request_completed") {
      await complete(
        record,
        "completed",
        record.terminal.usage ?? usage,
        nativeAttemptTime(record.terminal),
      );
    }
  };

  const onStatus = (event: ModelNetworkStatusEvent): Promise<void> =>
    enqueue(async () => {
      if (finished || !runtime.sessionPersisted || !runtime.sessionStore?.commitNativeContext)
        return;
      if (
        !["model_request_started", "model_request_completed", "model_request_failed"].includes(
          event.type,
        )
      )
        return;
      const identity = providerModelUsageIdentity(frozen.querySource, event);
      if (event.type === "model_request_started") {
        if (records.has(identity.id)) return;
        await ensureNativeState(owner);
        if (!nativeAttemptBoundary(owner, frozen)) return;
        await settlePendingSuccess([...records.values()].at(-1));
        const record: NativeAttemptRecord = {
          observation: prepareNativeAttempt(
            frozen,
            event,
            reserveNativeRequestSeq(owner, frozen.purpose),
          ),
          persisted: false,
        };
        records.set(identity.id, record);
        await persist(record);
        return;
      }
      const record = records.get(identity.id);
      if (!record || record.terminal) return;
      record.terminal = event;
      if (event.type === "model_request_failed") {
        await complete(
          record,
          event.reason === "cancelled" ? "cancelled" : "error",
          event.usage,
          nativeAttemptTime(event),
        );
      } else if (event.type === "model_request_completed" && event.usage !== undefined) {
        await complete(record, "completed", event.usage, nativeAttemptTime(event));
      }
    });

  const finish = (outcome: NativeContextAttemptOutcome): Promise<void> =>
    enqueue(async () => {
      if (finished) {
        if (outcome.status !== "completed") receiptSuccess = false;
        return;
      }
      finished = true;
      const attempts = [...records.values()];
      const last = attempts.at(-1);
      for (const record of attempts) {
        if (record.terminal?.type === "model_request_completed") {
          await settlePendingSuccess(
            record,
            record === last && outcome.status === "completed" ? outcome.usage : undefined,
          );
        } else if (!record.terminal) {
          await complete(
            record,
            record === last ? outcome.status : "obsolete",
            record === last ? outcome.usage : undefined,
            Date.now(),
          );
        }
        // prepared 写失败后，真实终态仍可补写同一个 ID；不再建立第二个点。
        if (
          record.persistedStatus !== record.observation.status &&
          record.observation.status !== "prepared"
        )
          await persist(record);
      }
      receiptSuccess =
        outcome.status === "completed" &&
        last?.observation.status === "completed" &&
        nativeAttemptBoundary(owner, frozen);
      if (receiptSuccess) {
        // 图片候选以此数组为 WeakMap 键，必须原地填真实请求身份并将原数组交回调用者。
        for (const receipt of sentImages)
          receipt.logicalRequestId = last!.observation.logicalRequestId;
      }
    });

  return {
    onStatus,
    finish,
    get successfulReceipts() {
      return receiptSuccess ? sentImages : noReceipts;
    },
    get observationIds() {
      return [...records.values()]
        .filter((record) => record.persisted)
        .map((record) => record.observation.id);
    },
  };
}
