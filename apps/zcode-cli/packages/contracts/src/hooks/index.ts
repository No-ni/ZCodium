/** 兼容公开入口；声明按职责由内部叶文件唯一提供。 */
export {
  HookEventName,
  HookOutcome,
  HookOnError,
  HookOnErrorSchema,
  HookSourceKind,
  HookPermissionDecision,
} from "./hook-events.js";
export type { HookConfigSource, HookExecutionDescriptor } from "./hook-events.js";
export { HookSpecificOutputSchema, HookJSONOutputSchema } from "./hook-io.js";
export type {
  BaseHookInput,
  PreToolUseHookInput,
  PermissionRequestHookInput,
  PostToolUseHookInput,
  PostToolUseFailureHookInput,
  UserPromptSubmitHookInput,
  SessionStartHookInput,
  StopHookInput,
  HookInput,
  PermissionRequestHookDecision,
  HookSpecificOutput,
  HookJSONOutput,
} from "./hook-io.js";
export {
  HookProcessConfigSchema,
  HookCommandConfigSchema,
  HookConfigSchema,
  HookMatcherConfigSchema,
  HooksRuntimeConfigPatchSchema,
  DefaultHooksRuntimeConfig,
} from "./hook-runtime-config.js";
export type {
  HookPluginContext,
  HookCommandConfig,
  HookProcessConfig,
  HookConfig,
  HookMatcherConfig,
  HooksRuntimeConfig,
  HooksRuntimeConfigPatch,
  HookRunLifecyclePayload,
} from "./hook-runtime-config.js";

export * from "./workspace-hook-trust.js";

export * from "./workspace-hook-trust-store.js";
