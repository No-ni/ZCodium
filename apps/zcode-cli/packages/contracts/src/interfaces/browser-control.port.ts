/** 兼容公开入口；声明按职责由内部叶文件唯一提供。 */
export { BROWSER_VIEWPORT_LIMITS } from "./browser-control-commands.js";
export type { BrowserCommandMethod, BrowserCommand } from "./browser-control-commands.js";
export type {
  BrowserErrorCode,
  BrowserPageState,
  BrowserSnapshotElement,
  BrowserSnapshotDomNode,
  BrowserSnapshot,
  BrowserTabSummary,
  BrowserUserTabInfo,
  BrowserResponseMeta,
  BrowserDialog,
  BrowserRecordingArtifact,
  BrowserRecordingJob,
  BrowserCommandResult,
} from "./browser-control-results.js";
export type {
  BrowserBackendType,
  BrowserCapabilityDescriptor,
  BrowserBackendDescriptor,
  BrowserBackendListResult,
  BrowserClientMode,
  BrowserSessionContextKind,
  BrowserDiscoveryContext,
  BrowserSessionContext,
  BrowserControlExecuteInput,
  BrowserControlListInput,
  BrowserChildSessionTabOwner,
  BrowserControlPort,
} from "./browser-control-attachment.js";

export type {
  BrowserViewportSize,
  BrowserMouseButton,
  BrowserKeyModifier,
  BrowserPlaywrightModifier,
  BrowserPlaywrightLocatorOperation,
  BrowserPlaywrightAction,
  BrowserPoint,
  BrowserRecordingAction,
  BrowserRecordingOptions,
} from "../protocol-values/contract.js";
