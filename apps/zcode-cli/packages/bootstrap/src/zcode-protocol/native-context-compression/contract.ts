import type {
  NativeContextImage,
  NativeContextImageRequest,
  NativeContextObservation,
  NativeContextOperationDetail,
  NativeContextOperationSummary,
  NativeContextPage,
  NativeContextPageRequest,
  NativeContextRecordRequest,
  NativeContextSourcePage,
  NativeContextSourceRequest,
  NativeContextStatus,
} from "@zcode/shared/native-context-compression";
import type { V4_METHODS } from "@zcode/shared/zcode-protocol-v4";

/** session 作用域由已有 workspace attachment 与 residency owner 解析，参数不能重选 owner。 */
export interface NativeContextQueryRuntime {
  getNativeContextCompression(): Promise<NativeContextStatus>;
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

export interface NativeContextQueryHost {
  /** 复用当前 CLI 的 lifecycle.ensureReady 与同一个 record，不另建 Runtime。 */
  getRuntime(sessionId: string): Promise<NativeContextQueryRuntime>;
}

export type NativeContextQueryMethod = (typeof V4_METHODS)[
  | "contextCompressionGet"
  | "contextCompressionObservations"
  | "contextCompressionRecords"
  | "contextCompressionRecord"
  | "contextCompressionSource"
  | "contextCompressionImage"];

export type NativeContextQueryResult =
  | NativeContextStatus
  | NativeContextPage<NativeContextObservation>
  | NativeContextPage<NativeContextOperationSummary>
  | NativeContextOperationDetail
  | NativeContextSourcePage
  | NativeContextImage;
