import type { CompactBoundaryPayload } from "../compact/index.js";
import type { HookRunLifecyclePayload } from "../hooks/index.js";
import type { ModelUsage, ModelUsageSummary } from "../protocol-values/model-contract.js";
import { createModelUsageSummary } from "../model/index.js";
import type { CheckpointCreatedPayload, RewindTriggeredPayload } from "../rewind/index.js";
import type {
  StreamRecoveryAnchorPayload,
  StreamRecoveryAnchorSelectedPayload,
  StreamRecoveryBlockedPayload,
  StreamRecoveryRetryStartedPayload,
  StreamRecoveryStartedPayload,
  StreamRecoveryTailDiscardedPayload,
  StreamingToolLedgerPayload,
} from "./stream-recovery.events.js";
import { SessionEventType } from "./session-event-envelope.js";
import type { SessionEvent } from "./session-event-envelope.js";
import type {
  ModelNetworkStatusPayload,
  ModelCompletePayload,
  SessionTitleUpdatedPayload,
  SessionModeChangedPayload,
  UserMessagePayload,
  AssistantMessagePayload,
  SystemMessagePayload,
  ModelRequestPayload,
  ModelSelectedPayload,
  TurnExecutionModelFallbackPayload,
  ModelStreamingPayload,
  ModelAnomalyWarningPayload,
  NetworkRequestStatusPayload,
  TargetCompletionVerificationPayload,
  ModelErrorPayload,
} from "./session-model-events.js";
import type {
  SessionCreatedPayload,
  SessionResumedPayload,
  SessionForkedPayload,
  SubagentSpawnedPayload,
  WorktreeCreatedPayload,
  SessionCompactedPayload,
  CompactLifecyclePayload,
  MicrocompactBoundaryEventPayload,
} from "./session-lifecycle-events.js";
import type {
  TurnStartedPayload,
  TurnInputReceivedPayload,
  TurnSteerQueuedPayload,
  TurnSteerDeliveryChangedPayload,
  TurnSteerDispatchChangedPayload,
  TurnSteerEditLockChangedPayload,
  TurnSteerDrainedPayload,
  TurnSteerReorderedPayload,
  QueueAutoDrainChangedPayload,
  FollowupModeChangedPayload,
  TurnSteerRejectedPayload,
  TurnSteerDiscardedPayload,
  SessionInputPromotedPayload,
  TurnCompletePayload,
  TurnErrorPayload,
} from "./session-turn-events.js";
import type {
  ToolCallScheduledPayload,
  ToolCallStartedPayload,
  ToolCallProgressPayload,
  ToolCallResultPayload,
  ToolCallErrorPayload,
  ToolBatchCompletePayload,
  BackgroundTaskStartedPayload,
  BackgroundTaskUpdatedPayload,
  BackgroundTaskCompletedPayload,
  DynamicWorkflowRunProgressPayload,
  PermissionRequestedPayload,
  PermissionResolvedPayload,
  PermissionDeniedPayload,
  PluginUiResourceUpdatedPayload,
  PluginUiResourceListChangedPayload,
  PluginUiAppToolCallRequestedPayload,
  UserInputAutoResolutionUpdatedPayload,
  WorkspaceHookReviewRequestedPayload,
  WorkspaceHookReviewSettledPayload,
  WorkspaceHookReviewSupersededPayload,
  WorkspaceHookAdmissionUpdatedPayload,
  WorkspaceMcpAdmissionUpdatedPayload,
} from "./session-interaction-events.js";

export function createModelUsageSummaryFromEvents(
  events: readonly SessionEvent[],
): ModelUsageSummary | undefined {
  const usages: ModelUsage[] = [];

  for (const event of events) {
    if (event.type === SessionEventType.ModelNetworkStatus) {
      const status = event.payload as Partial<ModelNetworkStatusPayload>;
      // 失败尝试不会产生 ModelComplete；只吸收其明确用量，不重复计算成功网络终态。
      if (status.type === "model_request_failed" && status.usage) usages.push(status.usage);
      continue;
    }
    if (event.type !== SessionEventType.ModelComplete) continue;
    const payload = event.payload as Partial<ModelCompletePayload>;
    if (payload.usage) {
      usages.push(payload.usage as ModelUsage);
    }
  }

  return createModelUsageSummary(usages);
}

export type SessionEventPayload =
  | SessionCreatedPayload
  | SessionResumedPayload
  | SessionForkedPayload
  | SubagentSpawnedPayload
  | WorktreeCreatedPayload
  | SessionCompactedPayload
  | SessionTitleUpdatedPayload
  | SessionModeChangedPayload
  | TurnStartedPayload
  | TurnInputReceivedPayload
  | TurnSteerQueuedPayload
  | TurnSteerDeliveryChangedPayload
  | TurnSteerDispatchChangedPayload
  | TurnSteerEditLockChangedPayload
  | TurnSteerDrainedPayload
  | TurnSteerReorderedPayload
  | QueueAutoDrainChangedPayload
  | FollowupModeChangedPayload
  | TurnSteerRejectedPayload
  | TurnSteerDiscardedPayload
  | SessionInputPromotedPayload
  | TurnCompletePayload
  | TurnErrorPayload
  | UserMessagePayload
  | AssistantMessagePayload
  | SystemMessagePayload
  | ModelRequestPayload
  | ModelSelectedPayload
  | TurnExecutionModelFallbackPayload
  | ModelStreamingPayload
  | StreamingToolLedgerPayload
  | StreamRecoveryAnchorPayload
  | StreamRecoveryStartedPayload
  | StreamRecoveryAnchorSelectedPayload
  | StreamRecoveryTailDiscardedPayload
  | StreamRecoveryRetryStartedPayload
  | StreamRecoveryBlockedPayload
  | ModelNetworkStatusPayload
  | ModelAnomalyWarningPayload
  | NetworkRequestStatusPayload
  | ModelCompletePayload
  | TargetCompletionVerificationPayload
  | ModelErrorPayload
  | ToolCallScheduledPayload
  | ToolCallStartedPayload
  | ToolCallProgressPayload
  | ToolCallResultPayload
  | ToolCallErrorPayload
  | ToolBatchCompletePayload
  | BackgroundTaskStartedPayload
  | BackgroundTaskUpdatedPayload
  | BackgroundTaskCompletedPayload
  | DynamicWorkflowRunProgressPayload
  | PermissionRequestedPayload
  | PermissionResolvedPayload
  | PermissionDeniedPayload
  | PluginUiResourceUpdatedPayload
  | PluginUiResourceListChangedPayload
  | PluginUiAppToolCallRequestedPayload
  | UserInputAutoResolutionUpdatedPayload
  | WorkspaceHookReviewRequestedPayload
  | WorkspaceHookReviewSettledPayload
  | WorkspaceHookReviewSupersededPayload
  | WorkspaceHookAdmissionUpdatedPayload
  | WorkspaceMcpAdmissionUpdatedPayload
  | HookRunLifecyclePayload
  | CompactLifecyclePayload
  | MicrocompactBoundaryEventPayload
  | CheckpointCreatedPayload
  | RewindTriggeredPayload
  | CompactBoundaryPayload;
