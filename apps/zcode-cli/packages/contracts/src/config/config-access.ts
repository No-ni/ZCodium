// Config Port - Scoped configuration with change notification
import type { CollaborationMode } from "../protocol-values/contract.js";
import type { McpServerConfig } from "../interfaces/mcp.port.js";
import type { HooksRuntimeConfig } from "../hooks/index.js";
import type { PluginConfig, PluginOptionValues } from "../plugins/index.js";
import type {
  SkillCommandOverride,
  ModelAnomalyGuardConfig,
  UiLocale,
  UiThemePreference,
  RuntimeConfig,
  RuntimeConfigPatch,
} from "./runtime-config.js";

// ============================================================
// Config Key Types
// ============================================================

export const ConfigKey = {
  ModelStreamIdleTimeout: "modelStream.idleTimeoutMs",

  // Permission
  PermissionMode: "permission.mode",
  PermissionAllowedTools: "permission.allowedTools",
  PermissionDisallowedTools: "permission.disallowedTools",
  PermissionAutoApproveHighRisk: "permission.autoApproveHighRisk",
  PermissionAllowMediumRiskInAuto: "permission.allowMediumRiskInAuto",

  // Storage
  StorageDir: "storage.dir",
  StorageSessionDbPath: "storage.sessionDbPath",

  // Network
  HttpProxy: "network.httpProxy",
  NoProxy: "network.noProxy",
  CaCertFile: "network.caCertFile",
  HttpTimeout: "network.timeout",

  // Features
  FeatureCompact: "features.compact",
  FeatureRewind: "features.rewind",
  FeatureSubagent: "features.subagent",
  FeatureMemory: "features.memory",
  FeatureSkill: "features.skill",
  FeatureMcp: "features.mcp",

  // Memory
  MemoryUse: "memory.use",

  // MCP
  McpServers: "mcp.servers",

  // Plugins
  PluginsEnabled: "plugins.enabled",
  PluginsDirs: "plugins.dirs",
  PluginsEnabledPlugins: "plugins.enabledPlugins",
  PluginsExtraKnownMarketplaces: "plugins.extraKnownMarketplaces",
  PluginsOptions: "plugins.options",
  PluginsSuppressedBuiltins: "plugins.suppressedBuiltins",

  // Skills
  SkillsEnabled: "skills.enabled",
  SkillsIncludeInstructions: "skills.includeInstructions",
  SkillsMetadataBudget: "skills.metadataBudget",
  SkillsRoots: "skills.roots",

  // Skill / Command 可用性覆盖（按 SKILL.md / 命令 .md 的绝对路径过滤）
  SkillOverrides: "skill",
  CommandOverrides: "command",

  // Logging
  LogLevel: "logging.level",
  LogFormat: "logging.format",

  // Tool Concurrency
  ToolConcurrencyMax: "toolConcurrency.maxConcurrency",

  // Model anomaly guards
  ModelAnomalyGuard: "modelAnomalyGuard",

  // Hooks
  Hooks: "hooks",

  // UI
  UiLocale: "ui.locale",
  UiTheme: "ui.theme",
} as const;

export type ConfigKey = (typeof ConfigKey)[keyof typeof ConfigKey];

// ============================================================
// Config Value Types
// ============================================================

export type ConfigValue<K extends ConfigKey> = K extends "modelStream.idleTimeoutMs"
  ? number
  : K extends "permission.mode"
    ? CollaborationMode
    : K extends "permission.allowedTools" | "permission.disallowedTools"
      ? string[]
      : K extends "permission.autoApproveHighRisk" | "permission.allowMediumRiskInAuto"
        ? boolean
        : K extends
              | "storage.dir"
              | "storage.sessionDbPath"
              | "network.httpProxy"
              | "network.noProxy"
              | "network.caCertFile"
          ? string | undefined
          : K extends "network.timeout"
            ? number
            : K extends
                  | "features.compact"
                  | "features.rewind"
                  | "features.subagent"
                  | "features.memory"
                  | "features.skill"
                  | "features.mcp"
                  | "skills.enabled"
                  | "skills.includeInstructions"
              ? boolean
              : K extends "memory.use"
                ? boolean
                : K extends "skills.metadataBudget"
                  ? number
                  : K extends "skills.roots"
                    ? string[]
                    : K extends "skill" | "command"
                      ? Record<string, SkillCommandOverride>
                      : K extends "mcp.servers"
                        ? Record<string, McpServerConfig>
                        : K extends "plugins.enabled"
                          ? boolean
                          : K extends "plugins.dirs"
                            ? string[]
                            : K extends "plugins.enabledPlugins"
                              ? Record<string, boolean>
                              : K extends "plugins.extraKnownMarketplaces"
                                ? PluginConfig["extraKnownMarketplaces"]
                                : K extends "plugins.options"
                                  ? Record<string, PluginOptionValues>
                                  : K extends "plugins.suppressedBuiltins"
                                    ? string[]
                                    : K extends "logging.level"
                                      ? "debug" | "info" | "warn" | "error"
                                      : K extends "logging.format"
                                        ? "text" | "json"
                                        : K extends "toolConcurrency.maxConcurrency"
                                          ? number
                                          : K extends "modelAnomalyGuard"
                                            ? ModelAnomalyGuardConfig
                                            : K extends "hooks"
                                              ? HooksRuntimeConfig
                                              : K extends "ui.locale"
                                                ? UiLocale
                                                : K extends "ui.theme"
                                                  ? UiThemePreference
                                                  : unknown;

// ============================================================
// Config Scope
// ============================================================

export const ConfigScope = {
  System: "system",
  User: "user",
  Project: "project",
  Session: "session",
  Env: "env",
  Cli: "cli",
} as const;

export type ConfigScope = (typeof ConfigScope)[keyof typeof ConfigScope];

export const ConfigScopePriority: Record<ConfigScope, number> = {
  [ConfigScope.System]: 0,
  [ConfigScope.User]: 10,
  [ConfigScope.Project]: 20,
  [ConfigScope.Session]: 30,
  [ConfigScope.Env]: 40,
  [ConfigScope.Cli]: 50,
};

// ============================================================
// Config Source
// ============================================================

export interface ConfigSource {
  scope: ConfigScope;
  key: ConfigKey;
  value: unknown;
  path?: string; // For file-based configs, the file path
}

// ============================================================
// Config Port Interface
// ============================================================

export interface Unsubscribe {
  (): void;
}

export interface ConfigObserver {
  subscribe<K extends ConfigKey>(
    key: K,
    handler: (value: ConfigValue<K>, prev: ConfigValue<K>) => void,
  ): Unsubscribe;
  subscribeAll(handler: (key: ConfigKey, value: unknown, prev: unknown) => void): Unsubscribe;
}

export interface ConfigPort {
  // Get configuration value
  get<K extends ConfigKey>(key: K): ConfigValue<K>;
  getAll(): RuntimeConfig;

  // Check if key exists
  has(key: ConfigKey): boolean;

  // Set configuration value (runtime only, not persisted by default)
  set<K extends ConfigKey>(key: K, value: ConfigValue<K>): void;

  // Get observer for scoped subscriptions
  observe(): ConfigObserver;

  // Get all sources for a key (for debugging/audit)
  getSources(key: ConfigKey): ConfigSource[];

  // Merge additional config (e.g., from file/env)
  merge(config: RuntimeConfigPatch, scope: ConfigScope): void;
}
