// Config Port - Scoped configuration with change notification
import type { CollaborationMode } from "../protocol-values/contract.js";
import type { McpServerConfig } from "../interfaces/mcp.port.js";
import type { HooksRuntimeConfig, HooksRuntimeConfigPatch } from "../hooks/index.js";
import type { PluginConfig } from "../plugins/index.js";

// ============================================================
// Skill / Command 可用性覆盖
// ============================================================

// 按绝对路径覆盖单个 skill / 命令是否可用。未列出的条目默认可用，
// 只有显式 enable:false 才会在发现阶段被过滤掉。
export interface SkillCommandOverride {
  enable?: boolean;
}

// ============================================================
// Runtime Config
// ============================================================

export interface RuntimeConfig {
  modelStream: ModelStreamConfig;
  permission: {
    mode: CollaborationMode;
    allowedTools: string[];
    disallowedTools: string[];
    autoApproveHighRisk: boolean;
    allowMediumRiskInAuto: boolean;
  };
  storage: {
    dir: string;
    sessionDbPath: string;
  };
  network: {
    httpProxy?: string;
    noProxy?: string;
    caCertFile?: string;
    timeout: number;
  };
  features: {
    compact: boolean;
    rewind: boolean;
    subagent: boolean;
    memory: boolean;
    skill: boolean;
    mcp: boolean;
  };
  memory: {
    use: boolean;
  };
  mcp: {
    servers: Record<string, McpServerConfig>;
  };
  plugins: PluginConfig;
  skills: {
    enabled: boolean;
    includeInstructions: boolean;
    metadataBudget: number;
    roots: string[];
    [skillPath: string]: boolean | number | string[] | { enable?: boolean };
  };
  // key 为 SKILL.md 绝对路径，value.enable=false 表示禁用该 skill
  skillOverrides: Record<string, SkillCommandOverride>;
  // key 为命令 .md 绝对路径，value.enable=false 表示禁用该命令
  commandOverrides: Record<string, SkillCommandOverride>;
  logging: {
    level: "debug" | "info" | "warn" | "error";
    format: "text" | "json";
  };
  toolConcurrency: ToolConcurrencyConfig;
  modelAnomalyGuard: ModelAnomalyGuardConfig;
  hooks: HooksRuntimeConfig;
  ui: {
    locale: UiLocale;
    theme: UiThemePreference;
  };
}

export interface RuntimeConfigPatch {
  modelStream?: Partial<ModelStreamConfig>;
  permission?: Partial<RuntimeConfig["permission"]>;
  storage?: Partial<RuntimeConfig["storage"]>;
  network?: Partial<RuntimeConfig["network"]>;
  features?: Partial<RuntimeConfig["features"]>;
  memory?: Partial<RuntimeConfig["memory"]>;
  mcp?: Partial<RuntimeConfig["mcp"]>;
  plugins?: Partial<RuntimeConfig["plugins"]>;
  skills?: Partial<RuntimeConfig["skills"]>;
  skillOverrides?: RuntimeConfig["skillOverrides"];
  commandOverrides?: RuntimeConfig["commandOverrides"];
  logging?: Partial<RuntimeConfig["logging"]>;
  toolConcurrency?: Partial<RuntimeConfig["toolConcurrency"]>;
  modelAnomalyGuard?: Partial<RuntimeConfig["modelAnomalyGuard"]>;
  hooks?: HooksRuntimeConfigPatch;
  ui?: Partial<RuntimeConfig["ui"]>;
}

export type SupportedLocale = "en-US" | "zh-CN";

export type UiLocale = SupportedLocale | "auto";

export type UiThemeMode = "dark" | "light";

export type UiThemePreference = UiThemeMode | "auto";

export const DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS = 600_000;

export interface ModelStreamConfig {
  idleTimeoutMs: number;
}

export const DefaultRuntimeConfig: RuntimeConfig = {
  modelStream: {
    idleTimeoutMs: DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS,
  },
  permission: {
    mode: "build",
    allowedTools: [],
    disallowedTools: [],
    autoApproveHighRisk: false,
    allowMediumRiskInAuto: false,
  },
  storage: {
    dir: "~/.zcodium",
    sessionDbPath: "~/.zcodium/cli/db/db.sqlite",
  },
  network: {
    timeout: 180000,
  },
  features: {
    compact: true,
    rewind: true,
    subagent: true,
    memory: true,
    skill: true,
    mcp: true,
  },
  memory: {
    use: true,
  },
  mcp: {
    servers: {},
  },
  plugins: {
    dirs: [],
    enabled: true,
    enabledPlugins: {},
    extraKnownMarketplaces: {},
    options: {},
    suppressedBuiltins: [],
  },
  skills: {
    enabled: true,
    includeInstructions: true,
    metadataBudget: 20_000,
    roots: [],
  },
  skillOverrides: {},
  commandOverrides: {},
  logging: {
    level: "info",
    format: "text",
  },
  toolConcurrency: {
    maxConcurrency: 10,
  },
  modelAnomalyGuard: {
    maxBudgetWarningsPerTurn: 3,
    repeatedToolCallWarningThreshold: 3,
  },
  hooks: {
    enabled: false,
    events: {},
    maxOutputBytes: 32768,
    timeoutMs: 60000,
  },
  ui: {
    locale: "en-US",
    theme: "auto",
  },
};

// ============================================================
// Tool Concurrency Config
// ============================================================

export interface ToolConcurrencyConfig {
  maxConcurrency: number;
}

export interface ModelAnomalyGuardConfig {
  toolCallWarningThreshold?: number;
  repeatedToolCallWarningThreshold: number;
  maxBudgetWarningsPerTurn: number;
}
