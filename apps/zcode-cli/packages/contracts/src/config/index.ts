/** 兼容公开入口；声明按职责由内部叶文件唯一提供。 */
export { DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS, DefaultRuntimeConfig } from "./runtime-config.js";
export type {
  SkillCommandOverride,
  RuntimeConfig,
  RuntimeConfigPatch,
  SupportedLocale,
  UiLocale,
  UiThemeMode,
  UiThemePreference,
  ModelStreamConfig,
  ToolConcurrencyConfig,
  ModelAnomalyGuardConfig,
} from "./runtime-config.js";
export { ConfigKey, ConfigScope, ConfigScopePriority } from "./config-access.js";
export type {
  ConfigValue,
  ConfigSource,
  Unsubscribe,
  ConfigObserver,
  ConfigPort,
} from "./config-access.js";
