import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";

class NativeContextCommandError extends Error {
  constructor(readonly reasonCode: string) {
    super(reasonCode);
    this.name = "NativeContextCommandError";
  }
}

function rejectNativeContextError(error: unknown): never {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    if (error.code === "conflict")
      throw new NativeContextCommandError("guard.nativeContextPolicyConflict");
    if (error.code === "busy")
      throw new NativeContextCommandError("guard.nativeContextOperationActive");
    if (error.code === "unavailable")
      throw new NativeContextCommandError("guard.nativeContextUnavailable");
    if (error.code === "stale-view")
      throw new NativeContextCommandError("guard.nativeContextStaleView");
  }
  throw error;
}

async function recordNativeCommandFact(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
  sessionId: string,
): Promise<void> {
  try {
    await host.recordPersistentCommandFact?.(
      sessionId,
      "timeline",
      {
        commandId: envelope.commandId,
        status: "accepted",
        revisionAtDecision: envelope.baseRevision ?? 0,
      },
      { commandType: envelope.type },
    );
  } catch {
    // CAS/入队已经成功，查重旁路失败不能把已接受动作伪装成失败；Runtime 同事务幂等仍有效。
    host.logger?.warn?.("v4 native context command fact unavailable", {
      commandId: envelope.commandId,
      commandType: envelope.type,
    });
  }
}

async function setPolicy(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const record = requireRecord(host, envelope.sessionId);
  const payload = envelope.payload as CommandPayloadMap["contextCompression.setPolicy"];
  try {
    await record.app.runtime.setNativeContextPolicy({
      configuration: payload.configuration,
      expectedPolicyVersion: payload.expectedPolicyVersion,
      commandId: envelope.commandId,
      traceContext: record.traceContext,
    });
  } catch (error) {
    rejectNativeContextError(error);
  }
  await recordNativeCommandFact(host, envelope, record.app.sessionId);
  return undefined;
}

async function compress(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const record = requireRecord(host, envelope.sessionId);
  if (record.restoreWarning) throw new NativeContextCommandError("guard.restoreWarning");
  const payload = envelope.payload as CommandPayloadMap["contextCompression.compress"];
  try {
    // 根因：等待模型终态会占住 CommandInbox gate，策略在维护 IO 中无法 CAS 更新。
    // Runtime 返回已持久 preparing 与入队 receipt 后立即释放；终态经同一事件流收口。
    await record.app.runtime.compressNativeContext({
      model: structuredClone(payload.model),
      commandId: envelope.commandId,
      abortSignal: record.app.runtime.shutdownSignal,
      traceContext: record.traceContext,
    });
  } catch (error) {
    rejectNativeContextError(error);
  }
  await recordNativeCommandFact(host, envelope, record.app.sessionId);
  return undefined;
}

export const nativeContextHandlers = {
  "contextCompression.setPolicy": setPolicy,
  "contextCompression.compress": compress,
} as const;
