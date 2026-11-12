import {
  zcodeNativeContextGetParamsSchema,
  zcodeNativeContextGetResultSchema,
  zcodeNativeContextImageParamsSchema,
  zcodeNativeContextImageResultSchema,
  zcodeNativeContextObservationsParamsSchema,
  zcodeNativeContextObservationsResultSchema,
  zcodeNativeContextRecordParamsSchema,
  zcodeNativeContextRecordResultSchema,
  zcodeNativeContextRecordsParamsSchema,
  zcodeNativeContextRecordsResultSchema,
  zcodeNativeContextSourceParamsSchema,
  zcodeNativeContextSourceResultSchema,
} from "@zcode/shared";
import { V4_METHODS } from "@zcode/shared/zcode-protocol-v4";
import { parseParams, type ParamsSchema } from "../server-types.js";
import type {
  NativeContextQueryHost,
  NativeContextQueryMethod,
  NativeContextQueryResult,
  NativeContextQueryRuntime,
} from "./contract.js";

async function readNativeContext<TParams extends { sessionId: string }, TResult>(
  host: NativeContextQueryHost,
  rawParams: unknown,
  paramsSchema: ParamsSchema<TParams>,
  resultSchema: ParamsSchema<TResult>,
  read: (runtime: NativeContextQueryRuntime, input: Omit<TParams, "sessionId">) => Promise<TResult>,
): Promise<TResult> {
  const { sessionId, ...input } = parseParams(paramsSchema, rawParams);
  const runtime = await host.getRuntime(sessionId);
  return resultSchema.parse(await read(runtime, input));
}

/** 仅在严格参数验证后解析 owner，未知字段或扩大读取预算不能启动冷恢复。 */
export async function queryNativeContextCompression(
  host: NativeContextQueryHost,
  method: NativeContextQueryMethod,
  rawParams: unknown,
): Promise<NativeContextQueryResult> {
  switch (method) {
    case V4_METHODS.contextCompressionGet:
      return readNativeContext(
        host,
        rawParams,
        zcodeNativeContextGetParamsSchema,
        zcodeNativeContextGetResultSchema,
        (runtime) => runtime.getNativeContextCompression(),
      );
    case V4_METHODS.contextCompressionObservations:
      return readNativeContext(
        host,
        rawParams,
        zcodeNativeContextObservationsParamsSchema,
        zcodeNativeContextObservationsResultSchema,
        (runtime, input) => runtime.listNativeContextObservations(input),
      );
    case V4_METHODS.contextCompressionRecords:
      return readNativeContext(
        host,
        rawParams,
        zcodeNativeContextRecordsParamsSchema,
        zcodeNativeContextRecordsResultSchema,
        (runtime, input) => runtime.listNativeContextRecords(input),
      );
    case V4_METHODS.contextCompressionRecord:
      return readNativeContext(
        host,
        rawParams,
        zcodeNativeContextRecordParamsSchema,
        zcodeNativeContextRecordResultSchema,
        (runtime, input) => runtime.readNativeContextRecord(input),
      );
    case V4_METHODS.contextCompressionSource:
      return readNativeContext(
        host,
        rawParams,
        zcodeNativeContextSourceParamsSchema,
        zcodeNativeContextSourceResultSchema,
        (runtime, input) => runtime.readNativeContextSource(input),
      );
    case V4_METHODS.contextCompressionImage:
      return readNativeContext(
        host,
        rawParams,
        zcodeNativeContextImageParamsSchema,
        zcodeNativeContextImageResultSchema,
        (runtime, input) => runtime.readNativeContextImage(input),
      );
  }
}
