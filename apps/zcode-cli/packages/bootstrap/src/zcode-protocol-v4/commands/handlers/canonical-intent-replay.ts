// 编辑/重试共用的重发入口：先预检，再截断历史，最后消费同一准入结果。
import type { CommandEnvelope, CommandPayloadMap } from "@zcode/shared/zcode-protocol-v4";
import type { mapAttachmentRefsToTurnAttachments } from "../attachment-refs.js";
import { inputIntentMetadataFromCanonical } from "../input-intent.js";
import { preflightPromptTurn, startPreflightedPromptTurn } from "../prompt-turn.js";
import type { V4CommandCoreHost, V4SessionRecordView } from "../types.js";
import { applyGoalCommand } from "./goal-compact.js";
import type { ConversationEditTarget } from "../../product-projection.js";

type SubmissionOverride = Pick<CommandPayloadMap["editUserQuery"], "modelSelection" | "mode" | "planEnabled">;
const EDIT_QUEUE_FALLBACK_REASON = "edit.admissionRace";

export function stableAttachmentRefs(editTarget: ConversationEditTarget) {
  return editTarget.intent.attachments?.flatMap((attachment) =>
    attachment.ref ? [{ ...attachment, ref: attachment.ref }] : [],
  );
}

function buildCanonicalIntent(
  envelope: CommandEnvelope,
  editTarget: ConversationEditTarget,
  text: string,
  attachmentRefs: ReturnType<typeof stableAttachmentRefs>,
  override: SubmissionOverride | undefined,
  requireQueue: boolean,
) {
  const intent = inputIntentMetadataFromCanonical(envelope, {
    kind: editTarget.intent.kind,
    conversationQuotes: envelope.type === "editUserQuery"
      ? ((envelope.payload as CommandPayloadMap["editUserQuery"]).conversationQuotes ?? editTarget.intent.conversationQuotes)
      : editTarget.intent.conversationQuotes,
    text: editTarget.intent.text,
    genUiContext: editTarget.intent.genUiContext,
    sourceCommandId: editTarget.intent.sourceCommandId,
    clientId: editTarget.intent.clientId,
    queueItemId: editTarget.intent.queueItemId,
    requestedDelivery: editTarget.intent.requestedDelivery,
    admittedDelivery: editTarget.intent.admittedDelivery,
    fallbackReasonCode: editTarget.intent.fallbackReasonCode,
    modelSelection: override?.modelSelection ?? editTarget.intent.modelSelection,
    mode: override?.mode ?? editTarget.intent.mode,
    planEnabled: override?.planEnabled ?? editTarget.intent.planEnabled,
    attachmentRefs,
    provenance: editTarget.intent.provenance,
  }, text);
  if (requireQueue) {
    intent.requestedDelivery = "queue";
    intent.admittedDelivery = "queue";
    intent.fallbackReasonCode = EDIT_QUEUE_FALLBACK_REASON;
  }
  return intent;
}

/** 预检无持久化与准入副作用；显式 Composer 选择必须与真正重发的选择一致。 */
export async function preflightCanonicalIntent(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  envelope: CommandEnvelope,
  editTarget: ConversationEditTarget,
  text: string,
  attachmentRefs: ReturnType<typeof stableAttachmentRefs>,
  attachments: Awaited<ReturnType<typeof mapAttachmentRefsToTurnAttachments>>,
  override?: SubmissionOverride,
): Promise<void> {
  if (editTarget.intent.kind === "sendGoalCommand") return;
  await preflightPromptTurn(host, record, {
    content: text,
    inputId: envelope.commandId,
    intent: buildCanonicalIntent(envelope, editTarget, text, attachmentRefs, override, false),
    ...(attachments ? { attachments } : {}),
  });
}

export async function startCanonicalIntent(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  envelope: CommandEnvelope,
  editTarget: ConversationEditTarget,
  text: string,
  attachmentRefs: ReturnType<typeof stableAttachmentRefs>,
  attachments: Awaited<ReturnType<typeof mapAttachmentRefsToTurnAttachments>>,
  override?: SubmissionOverride,
  options?: { requireQueue?: boolean },
): Promise<void> {
  const requireQueue = options?.requireQueue === true;
  const intent = buildCanonicalIntent(envelope, editTarget, text, attachmentRefs, override, requireQueue);
  if (editTarget.intent.kind === "sendGoalCommand") {
    await applyGoalCommand(host, record, {inputId: envelope.commandId, objective: text, intent});
    return;
  }
  // 修复依据：branch cut 之后重查可变 Registry 会丢失 replacement input；只消费事先通过的预检。
  const started = await startPreflightedPromptTurn(host, record, {
    content: text,
    inputId: envelope.commandId,
    intent,
    ...(requireQueue ? { requireQueue: true } : {}),
    ...(attachments ? { attachments } : {}),
  });
  if (requireQueue && started.admission.kind !== "queued") {
    throw new Error("edited input was not admitted to the queue");
  }
}
