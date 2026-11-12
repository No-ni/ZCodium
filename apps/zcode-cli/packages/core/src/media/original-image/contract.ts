import type {
  AttachmentRef,
  AttachmentStorageMetadata,
  SessionId,
  ToolArtifactStorePort,
  TraceContext,
  TurnId,
} from "@zcode/contracts";

export type OriginalImageProvenance = NonNullable<AttachmentRef["originalImage"]>;
export interface OriginalImagePersistenceRequest {
  data: Uint8Array;
  mediaType: string;
  sourceKind: Exclude<OriginalImageProvenance["sourceKind"], "browser">;
  preserveRaster?: boolean;
  artifactStore?: ToolArtifactStorePort;
  sessionId?: SessionId;
  turnId?: TurnId;
  toolCallId: string;
  toolName: string;
  trace?: TraceContext;
  signal?: AbortSignal;
}
export interface OriginalImagePersistenceResult {
  originalImage: OriginalImageProvenance;
  /** 仅供既有 Browser 截图路径提示；不会加入原图 provenance 或事件。 */
  path?: string;
}

export class OriginalImagePersistenceError extends Error {
  constructor(
    readonly reason: "unavailable" | "failed" | "invalid-result",
    cause?: unknown,
  ) {
    super(`Original image persistence ${reason}`, { cause });
    this.name = "OriginalImagePersistenceError";
  }
}
export interface OriginalImagePersistence {
  persist(
    request: OriginalImagePersistenceRequest,
  ): Promise<OriginalImagePersistenceResult | undefined>;
  fromMetadata(image: AttachmentStorageMetadata["image"]): OriginalImageProvenance | undefined;
}
