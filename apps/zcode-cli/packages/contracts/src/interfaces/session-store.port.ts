/** 兼容公开入口；声明按职责由内部叶文件唯一提供。 */
export { SESSION_TASK_TYPES } from "./session-store-session-info.js";
export type {
  SessionTaskType,
  SessionLastOutcome,
  SessionInfo,
  CreateSessionInput,
  UpdateSessionInput,
  FileDiff,
  SessionRevert,
  ListSessionsInput,
  ClaimLegacySessionWorkspaceInput,
  RepairLegacyRemoteSessionWorkspaceInput,
  RepairRemoteSessionPathsInput,
} from "./session-store-session-info.js";
export { MESSAGE_ANCHOR_ORIGINS } from "./session-store-message-semantics.js";
export type {
  MessageSemanticsOrigin,
  MessageSemanticsKind,
  MessageSemantics,
  MessageAnchorOrigin,
  StableForkGoalBoundaryMetadata,
  MessageProjectionAnchor,
} from "./session-store-message-semantics.js";
export type {
  StableForkTargetMetadata,
  ForkChildSessionMetadata,
  ForkCommandResult,
  ForkFromSourceInput,
  ForkCommitBundle,
  MessageCommitBundle,
  SharedContextImportCommitBundle,
  SharedContextImportStatus,
  SharedContextImportTransition,
} from "./session-store-transactions.js";
export type {
  OutputFormat,
  MessageSummary,
  MessageContextSnapshot,
  UserMessageInfo,
  AssistantErrorInfo,
  TokenUsageInfo,
  AssistantMessageInfo,
  MessageInfo,
} from "./session-store-message-info.js";
export type {
  TextPart,
  ReasoningPart,
  FilePartSource,
  AttachmentStorageMetadata,
  FilePart,
  AgentPart,
  CompactionPart,
  CompactionPartMetadata,
  SubtaskPart,
  RetryPart,
  StepStartPart,
  StepFinishPart,
  SnapshotPart,
  PatchPart,
} from "./session-store-message-parts.js";
export type {
  TimelinePartDisplay,
  TimelinePartStatus,
  TimelineModelSelection,
  TimelinePartBase,
  ContextCompactionTimelinePart,
  GoalVerificationTimelinePart,
  SessionForkTimelinePart,
  ModelChangeTimelinePart,
  WorktreeCreationFact,
  WorktreeCreationTimelinePart,
  TimelinePart,
  TimelinePartDraft,
} from "./session-store-timeline-parts.js";
export type {
  ToolStatePending,
  ToolStateRunning,
  ToolStateCompleted,
  ToolStateError,
  ToolState,
  ToolPart,
} from "./session-store-tool-parts.js";
export {
  BROWSER_TURN_SCREENSHOT_SOURCE,
  isBrowserTurnScreenshotPart,
  isAssistantBlockPart,
  assistantBlockParts,
  hasOrderedAssistantBlocks,
} from "./session-store-message.js";
export type { MessagePart, MessageWithParts } from "./session-store-message.js";
export {
  SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
  SESSION_ENTRY_MODEL_SELECTION,
  SESSION_ENTRY_EXECUTION_STATE,
  SESSION_ENTRY_USER_INPUT_AUTO_RESOLUTION,
  SESSION_ENTRY_WORKSPACE_CHECKPOINT,
  SESSION_ENTRY_WORKSPACE_FILE_REWIND,
  SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION,
  SESSION_ENTRY_SESSION_FEATURES,
  SESSION_ENTRY_PROMPT_SNAPSHOT,
  SESSION_ENTRY_TYPES,
} from "./session-store-entries.js";
export type {
  SessionEntryType,
  SessionEntryInfo,
  SessionInputDelivery,
  SessionInputStatus,
  SessionInputRecord,
} from "./session-store-entries.js";
export type {
  UsageQuerySource,
  UsageStatus,
  ModelUsageRecord,
  TurnUsageRecord,
  ToolUsageRecord,
  AppUsageQueryInput,
  AppUsageTotalsRow,
  AppUsageTurnTotalsRow,
  AppUsageToolTotalsRow,
  AppUsageModelRow,
  AppUsageToolRow,
  AppUsageDayRow,
  AppUsageDayModelRow,
  AppUsageQueryResult,
  TaskUsageQueryInput,
  TaskUsageQueryResult,
  UsageStorePort,
} from "./session-store-usage.js";
export type {
  LocalSettingStorePort,
  SessionDeletionReference,
  SessionDeletionSnapshot,
  SessionStorePort,
} from "./session-store-access.js";

export type {
  SessionTitleSource,
  MessageVisibility,
  SyntheticUserMessageSource,
} from "../protocol-values/contract.js";

export {
  SESSION_TITLE_SOURCES,
  MESSAGE_VISIBILITIES,
  SYNTHETIC_USER_MESSAGE_SOURCES,
} from "../protocol-values/contract.js";
