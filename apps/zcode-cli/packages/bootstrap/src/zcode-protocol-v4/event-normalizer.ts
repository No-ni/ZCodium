import { normalizeGenUiInput } from "@zcode/core";
import type { ModelStreamingPayload, SessionEvent, TurnStartedPayload } from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import {
  normalizeModelStreaming,
  runtimeTurnIdOf,
  normalizeAttachments,
  turnHeaderOrigin,
  userInputOrigin,
} from "./conversation-facts/contract.js";
import type {
  ConversationNormalizationDiagnostic,
  CanonicalUserIntentFact,
  CanonicalConversationFact,
  NormalizeConversationEventContext,
} from "./conversation-facts/contract.js";
export type {
  CanonicalConversationVisibility,
  CanonicalConversationOrigin,
  CanonicalConversationPlacement,
  ConversationNormalizationDiagnostic,
  CanonicalUserIntentFact,
  CanonicalTurnAttachment,
  CanonicalModelStream,
  CanonicalAssistantSegmentFact,
  CanonicalPassthroughFact,
  CanonicalConversationFact,
  NormalizeConversationEventContext,
  CanonicalOpenSegmentIdentity,
} from "./conversation-facts/contract.js";

/**
 * live SessionEvent 与 cold hydration 合成事件的唯一字段解释入口。
 *
 * 过去 ProductProjection 直接从 raw payload 分别猜 messageId、origin 与
 * visibility；cold 少一个字段时可见 row 仍会生成，但命令 target 缺失。normalizer
 * 先生成自包含 canonical fact，让 row、target、actions 使用同一份身份事实。
 */
export function normalizeConversationEvent(
  event: SessionEvent,
  context: NormalizeConversationEventContext = {},
): CanonicalConversationFact {
  const runtimeTurnId = runtimeTurnIdOf(event);
  const productTurnId = context.productTurnId ?? runtimeTurnId;
  if (event.type === SessionEventType.TurnStarted) {
    return normalizeTurnStarted(event, event.payload as TurnStartedPayload, {
      runtimeTurnId,
      productTurnId,
    });
  }
  if (event.type === SessionEventType.ModelStreaming) {
    return normalizeModelStreaming(event, event.payload as ModelStreamingPayload, {
      runtimeTurnId,
      productTurnId,
      openAssistantSegments: context.openAssistantSegments,
    });
  }
  if (
    event.type === SessionEventType.CompactStarted ||
    event.type === SessionEventType.CompactCompleted ||
    event.type === SessionEventType.CompactFailed
  ) {
    const payload = event.payload as Record<string, unknown>;
    const operationId =
      typeof payload.operationId === "string" && payload.operationId.length > 0
        ? payload.operationId
        : String(event.id);
    const transcriptMessageId =
      typeof payload.messageId === "string" && payload.messageId.length > 0
        ? payload.messageId
        : null;
    return {
      semanticKind: "passthrough",
      event,
      entityId: operationId,
      productTurnId,
      runtimeTurnId,
      transcriptMessageId,
      visibility: "visible",
      origin: "system",
      placement: { lane: "assistantWork", relation: "withinProductTurn" },
      diagnostics: [],
      ...(typeof payload.sourceCommandId === "string"
        ? { sourceCommandId: payload.sourceCommandId }
        : {}),
    };
  }
  return {
    semanticKind: "passthrough",
    event,
    entityId: String(event.id),
    productTurnId,
    runtimeTurnId,
    transcriptMessageId: null,
    visibility: "stateOnly",
    origin: "system",
    placement: { lane: "stateOnly", relation: "none" },
    diagnostics: [],
  };
}

function normalizeTurnStarted(
  event: SessionEvent,
  payload: TurnStartedPayload,
  ids: { runtimeTurnId: string; productTurnId: string },
): CanonicalUserIntentFact {
  const input = normalizeGenUiInput(payload.input, payload.intent?.genUiContext);
  const intentInput = normalizeGenUiInput(
    payload.intent?.text ?? payload.input,
    payload.intent?.genUiContext,
  );
  const transcriptMessageId = payload.messageId ? String(payload.messageId) : null;
  const origin = userInputOrigin(payload.inputSource);
  // live 使用 runtime turnId、cold 使用 hydrate-turn-N；即使二者指向
  // 同一条持久 user message，过去仍生成不同 productTurnId，导致行分组与命令边界
  // 在恢复前后漂移。真实用户轮以持久 user messageId 作为稳定 product turn 身份；
  // legacy 缺 messageId 时才保留 runtime fallback，并通过 diagnostics 暴露降级。
  // 可见 user、goal continuation、background wake 都是 product-turn trigger；
  // 只要有持久 messageId 就必须共用它，不能只稳定 realUser。
  const productTurnId = transcriptMessageId ?? ids.productTurnId;
  const diagnostics: ConversationNormalizationDiagnostic[] = transcriptMessageId
    ? []
    : [
        {
          code: "normalizer.user.missingTranscriptMessageId",
          eventId: String(event.id),
        },
      ];
  return {
    semanticKind: "userIntent",
    event,
    entityId:
      transcriptMessageId ??
      `legacy:user:${String(event.sessionId)}:${ids.runtimeTurnId}:${String(event.id)}`,
    productTurnId,
    runtimeTurnId: ids.runtimeTurnId,
    transcriptMessageId,
    visibility: payload.inputVisibility === "model-only" ? "modelOnly" : "visible",
    origin,
    placement: { lane: "trigger", relation: "withinProductTurn" },
    diagnostics,
    input: input.text,
    intentText: intentInput.text,
    intentKind: payload.intent?.kind === "sendGoalCommand" ? "sendGoalCommand" : "sendText",
    turnNumber: payload.turnNumber,
    executionKind: payload.executionKind ?? "agent",
    turnHeaderOrigin: turnHeaderOrigin(payload.inputSource),
    ...(payload.originMeta ? { originMeta: payload.originMeta } : {}),
    ...(payload.workflowLaunch ? { workflowLaunch: payload.workflowLaunch } : {}),
    ...(payload.epilogueStart === undefined ? {} : { epilogueStart: payload.epilogueStart }),
    ...((payload.intent?.sourceCommandId ?? payload.inputId)
      ? { sourceCommandId: payload.intent?.sourceCommandId ?? payload.inputId }
      : {}),
    ...(payload.foregroundExecutionId
      ? { foregroundExecutionId: payload.foregroundExecutionId }
      : {}),
    ...(payload.intent?.clientId ? { clientId: payload.intent.clientId } : {}),
    ...(payload.intent?.highspeed ? { highspeed: payload.intent.highspeed } : {}),
    ...(payload.intent?.queueItemId ? { queueItemId: payload.intent.queueItemId } : {}),
    ...(payload.intent?.admissionSeq !== undefined
      ? { admissionSeq: payload.intent.admissionSeq }
      : {}),
    ...(payload.intent?.admittedAt !== undefined ? { admittedAt: payload.intent.admittedAt } : {}),
    ...(payload.intent?.requestedDelivery
      ? { requestedDelivery: payload.intent.requestedDelivery }
      : {}),
    ...(payload.intent?.admittedDelivery
      ? { admittedDelivery: payload.intent.admittedDelivery }
      : {}),
    ...(intentInput.genUiContext !== undefined ? { genUiContext: intentInput.genUiContext } : {}),
    ...(payload.intent?.sharedContextRefs
      ? { sharedContextRefs: payload.intent.sharedContextRefs }
      : {}),
    ...(payload.intent?.fallbackReasonCode
      ? { fallbackReasonCode: payload.intent.fallbackReasonCode }
      : {}),
    ...(payload.intent?.modelSelection ? { modelSelection: payload.intent.modelSelection } : {}),
    ...(payload.intent?.mode ? { mode: payload.intent.mode } : {}),
    ...(payload.intent?.planEnabled !== undefined
      ? { planEnabled: payload.intent.planEnabled }
      : {}),
    ...(payload.intent?.inputOrigin ? { inputOrigin: payload.intent.inputOrigin } : {}),
    ...(payload.intent?.conversationQuotes
      ? { conversationQuotes: payload.intent.conversationQuotes }
      : {}),
    ...(payload.intent?.botGroupSource ? { botGroupSource: payload.intent.botGroupSource } : {}),
    ...(payload.intent?.provenance ? { provenance: payload.intent.provenance } : {}),
    ...(payload.intent?.source ? { source: payload.intent.source } : {}),
    ...normalizeAttachments(payload),
  };
}
