import {
  type MessageWithParts,
  type SessionId,
  type SessionInfo,
  type TraceContext,
} from "@zcode/contracts";
import {
  type AccessGrant,
  type CliScope,
  type CliSessionRef,
  type CliTrustedContext,
  type SendToSessionResult,
  type SessionSummary,
} from "@zcode/session-control/contracts";
import type { ZCodeApp } from "../app/types.js";
import type { CliSessionControlRuntimeOptions } from "./contract.js";
import { CliOperationObservations } from "./observation.js";
import { type Root } from "./runtimeFacts.js";
export interface RuntimeMethodContext {
  roots: Map<string, Root>;
  workspace: CliScope;
  options: CliSessionControlRuntimeOptions;
  observations: CliOperationObservations;
  releaseRootReservation(): void;
  assertOpen(): void;
  ref(sessionId: string): CliSessionRef;
  owner(session: CliSessionRef): Root;
  writable(session: CliSessionRef): Root;
  reserveRoot(): void;
  fence(ctx: CliTrustedContext): string;
  validate(ctx: CliTrustedContext, grant: AccessGrant<CliScope>): void;
  validateRead(ctx: CliTrustedContext, grant: AccessGrant<CliScope>): void;
  listStored(filter?: CliScope): Promise<SessionSummary<CliSessionRef>[]>;
  trace(ctx: CliTrustedContext, sessionId: SessionId): TraceContext;
  remember<T>(
    ctx: CliTrustedContext,
    action: string,
    input: { requestId: string },
    run: () => Promise<T>,
  ): Promise<T>;
  commandId(ctx: CliTrustedContext, requestId: string): string;
  attach(app: ZCodeApp, owned: boolean, verified?: boolean): Root;
  track(root: Root, completion: Promise<unknown>): void;
  storedRef(stored: SessionInfo): CliSessionRef;
  storedSummary(stored: SessionInfo): SessionSummary<CliSessionRef>;
  readStored(sessionId: string): Promise<SessionInfo | undefined>;
  readVisibleMessages(stored: SessionInfo): Promise<MessageWithParts[]>;
  summary(root: Root): Promise<SessionSummary<CliSessionRef>>;
  submit(
    ctx: CliTrustedContext,
    root: Root,
    prompt: string,
    requestId: string,
    grant: AccessGrant<CliScope>,
  ): Promise<SendToSessionResult<CliSessionRef>>;
}
