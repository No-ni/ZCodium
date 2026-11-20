import { resolve } from "node:path";
import type {
  ConfigPort,
  LoggerFactory,
  McpServerConfig,
  RuntimeConfig,
  RuntimeConfigPatch,
  WorkspaceHookBundleSnapshot,
} from "@zcode/contracts";
import {
  ConfigScope,
  DefaultRuntimeConfig,
  createWorkspaceHookBundleSnapshot,
} from "@zcode/contracts";
import {
  resolveSourcePersistenceRoots,
  assertSourceUserConfigPathAllowed,
} from "./source-persistence.js";
import {
  buildWorkspaceHookBundleSnapshot,
  resolveWorkspaceHookRuntimeRoot,
  type WorkspaceHookRuntimeRoot,
} from "@zcode/shared/workspace-hook-discovery";
import { createConfigPort } from "./index.js";
import { loadFileConfig, getDefaultConfigPath, type LoadedConfig } from "./file-config.adapter.js";
import { parseEnvConfig } from "./env-config.adapter.js";
import { mergeConfigs, createPrioritizedConfig } from "./config-merger.js";
import { withHookConfigSource } from "./config-hook-source.js";
import {
  loadProjectConfigFile,
  loadProjectConfigs,
  summarizeProjectConfigs,
  type ProjectConfigDiscovery,
  type ProjectConfigFile,
} from "./project-config.adapter.js";
import { logConfigDiagnostics } from "./config-diagnostics.js";

export {
  resolveZCodeDataBaseDir,
  resolveWorkspaceHookTrustIdentityForWorkspace,
  type LocalSessionDirectoryRelation,
  classifyLocalSessionDirectory,
} from "./workspace-trust-identity.js";

export interface ConfigFactoryOptions {
  /** Path to user config file (default: ~/.zcodium/cli/config.json) */
  userConfigPath?: string;
  /** Path to project config file */
  projectConfigPath?: string;
  /** Working directory used to discover project config files */
  workingDirectory?: string;
  /** Opaque workspace identity supplied by the existing Host resolver; local callers fall back to workspacePath. */
  workspaceIdentity?: string;
  /**
   * Hook Trust identity（D23），由调用方经 resolveWorkspaceHookTrustIdentityForWorkspace 预先算好。
   * createConfig 是同步函数，而 resolver 需要异步读取 .git 链接，所以不在这里解析。
   * 缺省时沿用旧规则（远程 identity 优先，否则工作目录）。
   */
  workspaceHookTrustIdentity?: string;
  /** Environment variables (default: process.env) */
  env?: Record<string, string | undefined>;
  /** CLI overrides (highest priority) */
  cliOverrides?: RuntimeConfigPatch;
  /** Skip loading user config file */
  skipUserConfig?: boolean;
  /** Optional logger factory for tests or embedding runtimes. Defaults to the node JSONL logger. */
  loggerFactory?: LoggerFactory;
}

export interface ConfigResult {
  configPort: ConfigPort;
  config: RuntimeConfig;
  sources: {
    user: {
      diagnostics: LoadedConfig["diagnostics"];
      path: string;
      loaded: boolean;
      hasMcpServers: boolean;
      hasUiLocale: boolean;
      hasUiTheme: boolean;
      mcpServerNames: string[];
    };
    project: {
      diagnostics: LoadedConfig["diagnostics"];
      path: string | undefined;
      paths: string[];
      loaded: boolean;
      hasUiLocale: boolean;
      hasUiTheme: boolean;
      hasMcpServers: boolean;
      mcpServerNames: string[];
      uiLocalePath: string | undefined;
      uiThemePath: string | undefined;
      workspaceHookSnapshot?: WorkspaceHookBundleSnapshot;
      /**
       * 审核请求与「审核中 toggle」曾各自推导 runtimeRoot（前者遍历
       * default/user/project/env/cli 全部层，后者只读单层 runtimeConfig.hooks），
       * 两者只要有一处不同就产生不同 bundleDigest，toggle 会被误判为
       * workspace_hooks_snapshot_mismatch。这里导出快照实际使用的 runtimeRoot，
       * 让下游复用同一个值，把一致性变成结构性约束而不是巧合。
       */
      workspaceHookRuntimeRoot?: WorkspaceHookRuntimeRoot;
    };
    plugins: PluginConfigSources;
    mcp: { serverSources: Record<string, McpServerConfigSource> };
    env: boolean;
    cli: boolean;
  };
}

type OptionalPathLoadedConfig = Omit<LoadedConfig, "path"> & { path: string | undefined };

export type McpServerConfigSource = "system" | "project" | "user" | "env" | "cli";

export type PluginConfigScope = "user" | "workspace";

export interface PluginConfigSources {
  dirs: { user: string[]; workspace: string[] };
  enabled: Record<string, PluginConfigScope>;
  marketplaces: Record<string, PluginConfigScope>;
  options: Record<string, Record<string, PluginConfigScope>>;
  /**
   * 插件选项的原始配置层，按优先级从低到高（user，再按发现顺序的项目配置文件）。
   * 合并后的 options 分不出值来自哪一层；敏感选项要按层叠加私有文件，所以保留原始层。
   */
  optionLayers: PluginOptionLayer[];
  paths: { user: string; workspace: string | undefined };
}

export interface PluginOptionLayer {
  scope: PluginConfigScope;
  path: string;
  /** workspace 层配置文件的 baseDir；私有文件按它找 workspace 条目。user 层没有。 */
  workspaceRoot?: string;
  options: Record<string, Record<string, string | number | boolean>>;
}

interface LoadedConfigSources {
  userConfigResult: LoadedConfig;
  discoveredProjectConfigs: ProjectConfigDiscovery;
}

function loadConfigSources(options: ConfigFactoryOptions): LoadedConfigSources {
  const sourceRoots = resolveSourcePersistenceRoots(options.env ?? process.env);
  if (sourceRoots) assertSourceUserConfigPathAllowed(options.userConfigPath, sourceRoots);
  // Source 的用户配置由 Source 持有，skipUserConfig 也必须先拒绝非法显式路径。
  const userConfigResult: LoadedConfig = options.skipUserConfig
    ? {
        config: {},
        diagnostics: [],
        path: sourceRoots?.cliConfigFile ?? getDefaultConfigPath(),
        loaded: false,
      }
    : loadFileConfig(options.userConfigPath ?? sourceRoots?.cliConfigFile);
  const discoveredProjectConfigs: ProjectConfigDiscovery = options.workingDirectory
    ? loadProjectConfigs(options.workingDirectory, options.projectConfigPath)
    : options.projectConfigPath
      ? summarizeProjectConfigs([
          loadProjectConfigFile(options.projectConfigPath, {
            discoveryOrder: 0,
            explicitProjectConfig: true,
          }),
        ])
      : summarizeProjectConfigs([]);
  return { userConfigResult, discoveredProjectConfigs };
}

/**
 * Create ConfigPort with all sources merged
 *
 * Priority (lowest to highest):
 * 1. System defaults
 * 2. User config file (~/.zcodium/cli/config.json)
 * 3. Project config files (root to cwd, then explicit projectConfigPath)
 * 4. Environment variables (ZCODE_*)
 * 5. CLI overrides
 */
export function createConfig(options: ConfigFactoryOptions = {}): ConfigResult {
  return assembleConfig(options, loadConfigSources(options));
}

function assembleConfig(options: ConfigFactoryOptions, sources: LoadedConfigSources): ConfigResult {
  const { userConfigResult, discoveredProjectConfigs } = sources;
  const sourceRoots = resolveSourcePersistenceRoots(options.env ?? process.env);
  // 1. System defaults
  const configs: ReturnType<typeof createPrioritizedConfig>[] = [
    createPrioritizedConfig(DefaultRuntimeConfig, ConfigScope.System),
  ];

  // 2. User config file
  if (userConfigResult.loaded) {
    configs.push(
      createPrioritizedConfig(
        withHookConfigSource(userConfigResult.config, {
          kind: "user",
          path: userConfigResult.path,
        }),
        ConfigScope.User,
      ),
    );
  }

  // 3. Project config files
  // explicit 配置曾在 auto-discovery 之后手工追加并自行编号，绕过 shared
  // canonical-path dedup；同一文件会进入 snapshot 两次并使既有 Trust 全部 stale。
  // 修法：有 workspace 时由 loadProjectConfigs 统一走 discoverWorkspaceHookConfigPaths，
  // 去重、失败候选占位和 discoveryOrder 均与 Settings builder 同源。
  const projectConfigFiles = discoveredProjectConfigs.files;
  const projectSummary = discoveredProjectConfigs;
  const projectDiagnostics = discoveredProjectConfigs.diagnostics;
  // 配置 diagnostics 过去只返回给调用方，用户导出日志时看不到加载失败或被跳过的 MCP server。
  // 在汇总入口统一写 warn，保留具体文件路径和 JSON path，方便定位迁移配置问题。
  logConfigDiagnostics({
    env: options.env,
    loggerFactory: options.loggerFactory,
    projectDiagnostics,
    userDiagnostics: userConfigResult.diagnostics,
  });
  const projectConfigResult: OptionalPathLoadedConfig =
    summarizeOptionalProjectConfig(projectConfigFiles);
  const projectUiLocalePath = [...projectConfigFiles]
    .reverse()
    .find((file) => file.config.ui?.locale !== undefined)?.path;
  const projectUiThemePath = [...projectConfigFiles]
    .reverse()
    .find((file) => file.config.ui?.theme !== undefined)?.path;

  for (const projectConfig of projectConfigFiles) {
    configs.push(createPrioritizedConfig(projectConfig.config, ConfigScope.Project));
  }

  // 4. Environment variables
  const envConfig = parseEnvConfig(options.env ?? process.env);
  if (Object.keys(envConfig).length > 0) {
    configs.push(
      createPrioritizedConfig(
        withHookConfigSource(envConfig, { kind: "internal" }),
        ConfigScope.Env,
      ),
    );
  }

  // 5. CLI overrides (applied last = highest priority)
  if (options.cliOverrides) {
    configs.push(
      createPrioritizedConfig(
        withHookConfigSource(options.cliOverrides, { kind: "internal" }),
        ConfigScope.Cli,
      ),
    );
  }

  const workspaceHookRuntimeRoot = resolveWorkspaceHookRuntimeRoot([
    DefaultRuntimeConfig.hooks,
    userConfigResult.config.hooks,
    ...projectSummary.hookCandidates.map((candidate) => candidate.hooks),
    envConfig.hooks,
    options.cliOverrides?.hooks,
  ]);
  const workspacePath = resolve(options.workingDirectory ?? process.cwd());
  const workspaceHookSnapshotData = buildWorkspaceHookBundleSnapshot({
    workspaceIdentity:
      options.workspaceHookTrustIdentity?.trim() ||
      options.workspaceIdentity?.trim() ||
      workspacePath,
    workspacePath,
    sources: projectSummary.hookCandidates,
    runtimeRoot: workspaceHookRuntimeRoot,
  });
  const workspaceHookSnapshot = workspaceHookSnapshotData
    ? createWorkspaceHookBundleSnapshot(workspaceHookSnapshotData)
    : undefined;

  // Project Hook events stay outside this executable merge. The snapshot above is the only
  // Phase 1 side-channel and cannot be consumed by configured-runner.
  const merged = mergeConfigs(...configs);

  // Source persistence 固定（最后覆盖）：storage.dir 与 sessionDbPath 属于 Source 根
  // owner，default/user/project/env/CLI 各层的同名覆盖不能逃出 Source 数据根。
  // 非 persistence 字段（hooks、ui、permission 等）保持普通优先级。
  if (sourceRoots) {
    merged.storage = {
      ...merged.storage,
      dir: sourceRoots.storageDir,
      sessionDbPath: sourceRoots.sessionDatabasePath,
    };
  }

  const pluginConfigSources = resolvePluginConfigSources({
    projectConfig: projectConfigResult.config,
    projectFiles: projectConfigFiles,
    projectPath: projectConfigResult.path,
    skipUserConfig: options.skipUserConfig === true,
    userConfig: userConfigResult.config,
    userPath: userConfigResult.path,
  });
  const mcpServerResolution = resolveEffectiveMcpServers({
    cliOverrides: options.cliOverrides,
    envConfig,
    projectConfig: projectConfigResult.config,
    userConfig: userConfigResult.config,
  });
  merged.mcp = { ...merged.mcp, servers: mcpServerResolution.servers };

  // Create ConfigPort with merged config
  const configPort = createConfigPort(merged);

  return {
    configPort,
    config: configPort.getAll(),
    sources: {
      user: {
        diagnostics: userConfigResult.diagnostics,
        path: userConfigResult.path,
        loaded: userConfigResult.loaded,
        hasMcpServers: userConfigResult.config.mcp?.servers !== undefined,
        hasUiLocale: userConfigResult.config.ui?.locale !== undefined,
        hasUiTheme: userConfigResult.config.ui?.theme !== undefined,
        mcpServerNames: Object.keys(userConfigResult.config.mcp?.servers ?? {}),
      },
      project: {
        diagnostics: projectDiagnostics,
        path: projectConfigResult.path,
        paths: projectSummary.paths,
        loaded: projectConfigResult.loaded,
        hasUiLocale: projectConfigResult.config.ui?.locale !== undefined,
        hasUiTheme: projectConfigResult.config.ui?.theme !== undefined,
        hasMcpServers: projectConfigResult.config.mcp?.servers !== undefined,
        mcpServerNames: projectSummary.mcpServerNames,
        uiLocalePath: projectUiLocalePath,
        uiThemePath: projectUiThemePath,
        ...(workspaceHookSnapshot ? { workspaceHookSnapshot } : {}),
        workspaceHookRuntimeRoot,
      },
      plugins: pluginConfigSources,
      mcp: { serverSources: mcpServerResolution.sources },
      env: Object.keys(envConfig).length > 0,
      cli: !!options.cliOverrides,
    },
  };
}

function resolvePluginConfigSources(input: {
  projectConfig: RuntimeConfigPatch;
  projectFiles: readonly ProjectConfigFile[];
  projectPath: string | undefined;
  skipUserConfig: boolean;
  userConfig: RuntimeConfigPatch;
  userPath: string;
}): PluginConfigSources {
  const enabled: Record<string, PluginConfigScope> = {};
  const marketplaces: Record<string, PluginConfigScope> = {};
  const options: Record<string, Record<string, PluginConfigScope>> = {};

  for (const pluginId of Object.keys(input.userConfig.plugins?.enabledPlugins ?? {})) {
    enabled[pluginId] = "user";
  }
  for (const pluginId of Object.keys(input.projectConfig.plugins?.enabledPlugins ?? {})) {
    enabled[pluginId] = "workspace";
  }

  for (const marketplaceId of Object.keys(input.userConfig.plugins?.extraKnownMarketplaces ?? {})) {
    marketplaces[marketplaceId] = "user";
  }
  for (const [pluginId, pluginOptions] of Object.entries(input.userConfig.plugins?.options ?? {})) {
    options[pluginId] = {};
    for (const key of Object.keys(pluginOptions)) options[pluginId][key] = "user";
  }
  for (const [pluginId, pluginOptions] of Object.entries(
    input.projectConfig.plugins?.options ?? {},
  )) {
    const sourceByKey = (options[pluginId] ??= {});
    for (const key of Object.keys(pluginOptions)) sourceByKey[key] = "workspace";
  }

  return {
    dirs: {
      user: input.userConfig.plugins?.dirs ?? [],
      workspace: input.projectConfig.plugins?.dirs ?? [],
    },
    enabled,
    marketplaces,
    options,
    optionLayers: [
      ...(input.skipUserConfig
        ? []
        : [
            {
              scope: "user" as const,
              path: input.userPath,
              options: input.userConfig.plugins?.options ?? {},
            },
          ]),
      ...input.projectFiles.map((file) => ({
        scope: "workspace" as const,
        path: file.path,
        workspaceRoot: file.baseDir,
        options: file.config.plugins?.options ?? {},
      })),
    ],
    paths: { user: input.userPath, workspace: input.projectPath },
  };
}

export function resolveWorkspaceStorageDir(input: {
  env?: Record<string, string | undefined>;
  workingDirectory: string;
}): string {
  const sourceRoots = resolveSourcePersistenceRoots(input.env ?? process.env);
  // Source 分支：与 createConfig 相同，Source 根拥有 storage.dir，env/project 不能改写。
  if (sourceRoots) return sourceRoots.storageDir;
  const baseStorageDir = createConfig({ env: input.env }).config.storage.dir;
  const projectConfig = loadProjectConfigs(input.workingDirectory);
  let projectStorageDir: string | undefined;
  for (const file of projectConfig.files) {
    projectStorageDir = file.config.storage?.dir ?? projectStorageDir;
  }
  const envStorageDir = parseEnvConfig(input.env ?? process.env).storage?.dir;
  return envStorageDir ?? projectStorageDir ?? baseStorageDir;
}

function resolveEffectiveMcpServers(input: {
  cliOverrides?: RuntimeConfigPatch;
  envConfig: RuntimeConfigPatch;
  projectConfig: RuntimeConfigPatch;
  userConfig: RuntimeConfigPatch;
}): { servers: Record<string, McpServerConfig>; sources: Record<string, McpServerConfigSource> } {
  const servers: Record<string, McpServerConfig> = {};
  const sources: Record<string, McpServerConfigSource> = {};
  const apply = (source: McpServerConfigSource, patch: RuntimeConfigPatch | undefined) => {
    for (const [name, server] of Object.entries(patch?.mcp?.servers ?? {})) {
      servers[name] = server;
      sources[name] = source;
    }
  };

  apply("system", DefaultRuntimeConfig);
  // MCP server discovery has an extension-specific rule: user config shadows project config.
  // This does not change the global config precedence for model/permission/UI fields.
  apply("project", input.projectConfig);
  apply("user", input.userConfig);
  apply("env", input.envConfig);
  apply("cli", input.cliOverrides);
  return { servers, sources };
}

function summarizeOptionalProjectConfig(files: ProjectConfigFile[]): OptionalPathLoadedConfig {
  if (files.length === 0) {
    return { config: {}, diagnostics: [], path: undefined, loaded: false };
  }

  const path = files[files.length - 1]?.path;
  const config = mergeConfigs(
    ...files.map((file) => createPrioritizedConfig(file.config, ConfigScope.Project)),
  );

  return { config, diagnostics: files.flatMap((file) => file.diagnostics), path, loaded: true };
}
