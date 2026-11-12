import type { ModelSelection } from "@zcode/shared";
import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";
import type {
  NativeContextConfiguration,
  NativeContextImage,
  NativeContextObservation,
  NativeContextOperationDetail,
  NativeContextOperationSummary,
  NativeContextPage,
  NativeContextRecordRequest,
  NativeContextSourcePage,
  NativeContextStatus,
} from "@zcode/shared/native-context-compression";

export type {
  NativeContextConfiguration,
  NativeContextImage,
  NativeContextObservation,
  NativeContextOperationDetail,
  NativeContextOperationSummary,
  NativeContextSourcePage,
  NativeContextStatus,
};

/** UI 意图只交给 SessionPane 的既有 command admission。 */
export interface NativeContextActions {
  setPolicy(
    configuration: NativeContextConfiguration,
    expectedPolicyVersion: number,
  ): Promise<CommandAck>;
  compress(model: ModelSelection): Promise<CommandAck>;
  deepCompact(): void;
}

export interface NativeContextModelCandidate {
  selection: ModelSelection;
  label: string;
  supportsImages?: boolean;
}

export interface NativeContextIdentity {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  sessionId: string | null;
}

export interface NativeContextReadController {
  scopeKey: string;
  status: NativeContextStatus | null;
  loading: boolean;
  unavailable: boolean;
  error: boolean;
  refresh(): Promise<NativeContextStatus | null>;
  observations(options?: {
    cursor?: number;
    limit?: number;
    segmentId?: string;
    purpose?: NativeContextObservation["purpose"];
    operationId?: string;
  }): Promise<NativeContextPage<NativeContextObservation>>;
  records(options?: {
    cursor?: number;
    limit?: number;
  }): Promise<NativeContextPage<NativeContextOperationSummary>>;
  record(
    operationId: string,
    options?: Omit<NativeContextRecordRequest, "sessionId" | "operationId" | "expectedRevision">,
  ): Promise<NativeContextOperationDetail>;
  source(ref: string, offset?: number): Promise<NativeContextSourcePage>;
  image(ref: string): Promise<NativeContextImage & { blob: Blob | null }>;
}

export type NativeContextTab = "overview" | "trends" | "records" | "parameters";

export interface NativeContextParameterDraft {
  configuration: NativeContextConfiguration;
  baseConfiguration: NativeContextConfiguration;
  baseVersion: number;
  rawFields: Readonly<Record<string, string>>;
  jsonText: string;
  jsonPending: boolean;
  jsonError: boolean;
}
