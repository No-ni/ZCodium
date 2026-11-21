/** 兼容公开入口；声明按职责由内部叶文件唯一提供。 */
export type {
  BrowserBackendType,
  BrowserCapabilityDescriptor,
  BrowserBackendDescriptor,
  BrowserBackendListResult,
  BrowserClientMode,
  BrowserSessionContextKind,
  BrowserDiscoveryContext,
  BrowserSessionContext,
} from "./browser-control-context.js";
export type {
  BrowserControlExecuteInput,
  BrowserControlListInput,
  BrowserChildSessionTabOwner,
  BrowserControlPort,
} from "./browser-control-execution.js";
