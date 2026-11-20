import { CONTEXT_SOURCE_INSTRUCTIONS_READ_FAILED } from "@zcode/contracts";
import {
  traceContextToLogContext,
  createContextBuilder,
  createSubagentContextBuilder,
} from "../deps.js";
import type {
  Model,
  SkillLoadOutcome,
  TraceContext,
  ContextSourceSnapshot,
  ContextBuilder,
  ContextBuilderConfig,
  ContextBuildResult,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { ensureMemoryDirectoryExists } from "../../memory/directory.js";
import {
  ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH,
  type ProjectMemoryRetrievalBranch,
} from "../../memory/project-memory-retrieval-branch.js";
import { setReadFileStateEntry } from "../../tool/read-file-state.js";
import type { ReadFileStateEntry } from "../../tool/types.js";
import type { ResolvedUserInstructions } from "../../context/types.js";
import { resolveEnabledProjectMemoryRoot } from "../helpers/project-memory.js";
import { workspaceLevelRootOf, workspaceScopeRootOf } from "../helpers/workspace-scope.js";
import { shouldUseMidConversationSystem } from "../helpers/runtime-provider-request-messages.js";
import { buildContextHistoryEntries } from "./context-history-entries.js";
import { resolveRuntimeEmbeddedSearchEnabled } from "./embedded-search-branch.js";
import { getContextSourceShellDisplayName } from "./session-shell-environment.js";
import {
  ensureGenUiOutputDirectory,
  resolveGenUiOutputDirectory,
} from "../helpers/gen-ui-output.js";
import { type ProjectMemoryIndexRead, readProjectMemoryIndex } from "./project-memory-index.js";
export { extractToolCallsFromResult, shouldStreamModelText } from "./context-model-result.js";

export { type ProjectMemoryIndexRead } from "./project-memory-index.js";

export { buildContextHistoryEntries };

export async function ensureContextInitialized(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
  model?: Model,
): Promise<void> {
  if (this.contextInitialized) return;

  const shellDisplayName = getContextSourceShellDisplayName(this);
  // child 的快照只由父级传下的配置组成（envInfo、日期、指令快照），端口只留给 cd 之后的环境探测。
  // 修复原因：child 持有父级端口后在这里走完整解析，会重新查找 project root、探测 Project Context，
  // 而 child 的 context builder 不使用这些结果，每次启动都白读一次磁盘。
  const contextSourcePort = this.config.subagentContext ? undefined : this.contextSourcePort;
  const snapshot = contextSourcePort
    ? await contextSourcePort.resolveContextSources(
        {
          workingDirectory: this.workingDirectory,
          currentDate: this.config.currentDate,
          effectiveShellDisplayName: shellDisplayName,
          envInfo: this.config.envInfo,
          userInstructions: this.config.userInstructions
            ? {
                ...this.config.userInstructions,
                workingDirectory:
                  this.config.userInstructions.workingDirectory ?? this.workingDirectory,
              }
            : undefined,
          projectContext: this.config.projectContext,
          trace: traceContext,
        },
        { signal: undefined },
      )
    : this.createConfigOnlyContextSnapshot(this.workingDirectory);

  this.workingDirectory = snapshot.workingDirectory;
  // Bash cd 之后 workingDirectory 会变化，但 workspaceRoot 仍表示会话初始工作区边界。
  this.workspaceRoot = snapshot.workingDirectory;
  // 工作区键路径与执行边界**同点**更新，原因分两种调用方：
  // - 协议/远程会话恒有 `config.workspacePath`（对话根），这一支等于不改，身份仍不随执行
  //   cwd 漂移；
  // - CLI/TUI 独立运行不传 workspacePath，此时工作区身份本就等于「本次会话的执行边界」。
  //   冷恢复（`cd /tmp && zcode -p --resume <id>`）时构造期的启动 cwd 已不是本次会话的
  //   边界（`resumeFromStore` 把执行 cwd 换成持久化的 `path`），继续冻结它会让 projectID、
  //   项目记忆、hook 执行 cwd 与 MCP 身份跟到 `/tmp`，与改动前行为不一致
  //   （见 docs/specs/conversation-session-workspace.md 规则 6）。
  // Bash cd 只改 `workingDirectory`，不会重跑本方法，因此执行边界之后的漂移仍不改身份。
  this.workspaceScopeRoot = this.config.workspacePath ?? snapshot.workingDirectory;
  this.contextSourceSnapshot = snapshot;
  this.sessionStartGitPrefetch = true;
  this.startMcpStartup(traceContext);
  this.skillLoadOutcome = await this.discoverSkillsForContext(traceContext);
  this.memoryRoot = await this.loadProjectMemoryRoot(traceContext);
  const memoryIndex = await loadProjectMemoryIndex(
    this,
    this.memoryRoot,
    ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH,
  );
  this.memoryIndexContent = memoryIndex.index?.content;
  // 读不出来的文件不算删除：这一轮的比较不把它们列进 removed，模型保留已宣告的副本。
  this.unreadableInstructionPaths = new Set(
    unreadableInstructionPaths(this, snapshot, memoryIndex, traceContext),
  );
  await ensureGenUiOutputDirectory(this);
  await ensureGenUiOutputDirectory(this);
  this.contextBuilder = this.createContextBuilderFromSnapshot(snapshot, this.memoryRoot, {
    memoryIndexContent: this.memoryIndexContent,
    model,
  });
  // Bug 根因：模型创建失败轮会在 Context 首次可初始化前接纳并持久化用户输入。
  // init 会替换全部内存历史，因此先保留这些权威运行条目，再接到新建的 Context 前缀之后。
  const preContextEntries = [...this.messageHistory.borrowReadOnlyRuntimeEntries()];
  this.initializeMessageHistoryFromContext(this.contextBuilder, traceContext);
  this.messageHistory.addEntries(preContextEntries);
  this.contextInitialized = true;
}

export async function getSkillCatalog(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<SkillLoadOutcome> {
  // Composer 曾独立扫描磁盘，所以运行中的 Session 会看到 AgentRuntime
  // 尚未加载的新 Skill。先经过 runtime 唯一的 context 初始化门，再返回防御性副本，
  // 让 UI 与本 Session 实际可用的 Skill 保持同一快照；新 runtime 会自然重新发现。
  await this.ensureContextInitialized(traceContext);
  const outcome = this.skillLoadOutcome ?? { skills: [], diagnostics: [], totalDiscovered: 0 };
  return {
    skills: outcome.skills.map((skill) => ({ ...skill })),
    diagnostics: outcome.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    totalDiscovered: outcome.totalDiscovered,
  };
}

export function createContextBuilderFromSnapshot(
  this: AgentRuntimeInternal,
  snapshot: ContextSourceSnapshot,
  memoryRoot?: string,
  options: { memoryIndexContent?: string; model?: Model; persistEnvInfo?: boolean } = {},
): ContextBuilder {
  const envInfo = snapshot.envInfo;
  // 同步 preview / config-only fallback 会构造 unknown envInfo。
  // 这类临时值不能写回 config，否则首轮真实 context source 会把它当作显式 envInfo，
  // 从而跳过 Node env/git 探测。
  if (options.persistEnvInfo !== false) {
    // 执行模型属于 model step，不写回可复用的 Context Source。
    this.config.envInfo = envInfo;
  }
  if (this.config.subagentContext) {
    return createSubagentContextBuilder({
      agentPrompt: this.config.subagentContext.agentPrompt,
      currentDate: snapshot.currentDate,
      envInfo,
      model: options.model,
      skillMetadataBudget: this.config.skillMetadataBudget,
      skills: this.skillLoadOutcome,
      userInstructions: this.config.subagentContext.userInstructions,
    });
  }

  const contextConfig: ContextBuilderConfig = {
    workingDirectory: snapshot.workingDirectory,
    additionalDirectories: this.config.additionalDirectories,
    envInfo,
    model: options.model,
    ...(options.model
      ? { midConversationSystem: shouldUseMidConversationSystem(this.config, options.model) }
      : {}),
    presentationSurface: this.config.presentationSurface,
    genUiOutputDirectory: resolveGenUiOutputDirectory(this),
    currentDate: snapshot.currentDate,
    userInstructions: snapshot.userInstructions,
    projectContext: snapshot.projectContext,
    memoryIndexContent: options.memoryIndexContent,
    memoryRoot,
    skills: this.skillLoadOutcome,
    agentProfiles: this.config.subagents?.profiles,
    embeddedSearchEnabled: resolveRuntimeEmbeddedSearchEnabled(this),
    skillMetadataBudget: this.config.skillMetadataBudget,
    customSystemPrompt: this.config.systemPrompt,
    workflowActor: this.config.workflowActor,
    language: this.config.language,
    outputStyle: this.config.outputStyle,
    compact: this.config.compact,
    guidanceToolNames: this.getTools(options.model).map((tool) => tool.name),
  };

  return createContextBuilder(contextConfig).setToolRegistry(this.registry);
}

export async function loadProjectMemoryRoot(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<string | undefined> {
  // 项目记忆根按工作区键路径分桶：用执行 cwd 会让对话会话每个会话各建一份记忆。
  const memoryRoot = resolveEnabledProjectMemoryRoot(this.config, workspaceScopeRootOf(this));
  if (!memoryRoot) {
    this.logMemorySkipped(traceContext, "disabled_or_excluded", { taskType: this.config.taskType });
    return undefined;
  }
  if (!this.fileSystemPort) {
    this.logMemorySkipped(traceContext, "missing_file_system_port", { memoryRoot });
    return undefined;
  }
  await ensureMemoryDirectoryExists(this.fileSystemPort, memoryRoot, traceContext, this.logger);
  return memoryRoot;
}

/** 读取 Memory 索引并写入读取状态；读不出来的路径交给调用方。 */
export async function loadProjectMemoryIndex(
  runtime: AgentRuntimeInternal,
  memoryRoot: string | undefined,
  retrievalBranch: ProjectMemoryRetrievalBranch,
): Promise<ProjectMemoryIndexRead> {
  const read = await readProjectMemoryIndex(runtime, memoryRoot, retrievalBranch);
  if (read.index) setReadFileStateEntry(runtime.readFileState, read.index.readFileStateEntry);
  return read;
}

/** 本次读取中读不出来的指令文件与 Memory 索引路径，每个路径记一条 warn。 */
function unreadableInstructionPaths(
  runtime: AgentRuntimeInternal,
  sources: Pick<ContextSourceSnapshot, "diagnostics">,
  memoryIndex: ProjectMemoryIndexRead,
  traceContext: TraceContext,
): string[] {
  const paths = [
    ...sources.diagnostics.flatMap((diagnostic) =>
      diagnostic.code === CONTEXT_SOURCE_INSTRUCTIONS_READ_FAILED && diagnostic.path
        ? [diagnostic.path]
        : [],
    ),
    ...(memoryIndex.unreadablePath ? [memoryIndex.unreadablePath] : []),
  ];
  for (const path of paths) {
    runtime.logger?.warn("Instruction file read failed", {
      ...traceContextToLogContext(traceContext),
      event: "context.instructions.read_failed",
      path,
    });
  }
  return paths;
}

export interface InstructionSourcesReread {
  userInstructions: ResolvedUserInstructions | undefined;
  memoryIndex: { content: string; readFileStateEntry: ReadFileStateEntry } | undefined;
  /** 读不出来、但 runtime 没有持有的路径；采用重读后这些路径仍不算删除。 */
  unreadablePaths: string[];
}

/**
 * compaction 收尾时重读指令文件与 Memory 索引，只读不改 runtime。
 * 修复原因：原来 compaction 沿用 runtime 启动时读到的内容；会话中途改过的 AGENTS.md / MEMORY.md
 * 在 compact 之后仍以旧内容宣告，模型一直看不到新内容。
 * 没有 context port（子 agent）时不重读；读取失败、或 runtime 持有的文件读不出来时返回 undefined，
 * 沿用原内容；取消时抛出。
 */
export async function rereadInstructionSources(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<InstructionSourcesReread | undefined> {
  const port = runtime.config.subagentContext ? undefined : runtime.contextSourcePort;
  const snapshot = runtime.contextSourceSnapshot;
  if (!port || !snapshot) return undefined;
  const userInstructions = runtime.config.userInstructions;
  try {
    // 传入快照里的 envInfo 与 projectContext，端口不再探测环境与 Git。
    const [sources, memoryIndex] = await Promise.all([
      port.resolveContextSources(
        {
          workingDirectory: snapshot.workingDirectory,
          currentDate: snapshot.currentDate,
          envInfo: snapshot.envInfo,
          projectContext: snapshot.projectContext,
          userInstructions: userInstructions
            ? {
                ...userInstructions,
                workingDirectory: userInstructions.workingDirectory ?? snapshot.workingDirectory,
              }
            : undefined,
          trace: traceContext,
        },
        { signal },
      ),
      readProjectMemoryIndex(runtime, runtime.memoryRoot, ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH),
    ]);
    const unreadablePaths = unreadableInstructionPaths(runtime, sources, memoryIndex, traceContext);
    // runtime 持有的文件读不出来：整次重读作废，沿用原内容，下一次读取再试。
    const held = runtime.latestContextBuildResult?.metaUserAttachments.find(
      (item) => item.source === "context_prefix",
    )?.files;
    if (held?.some((file) => unreadablePaths.includes(file.path))) return undefined;
    return {
      userInstructions: sources.userInstructions,
      memoryIndex: memoryIndex.index,
      unreadablePaths,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    runtime.logger?.warn("Instruction re-read after compaction failed", {
      ...traceContextToLogContext(traceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "context.instructions.reread_failed",
    });
    return undefined;
  }
}

/**
 * 按重读的内容构建一次公告来源，只给 summary 之前的指令公告用；不改 runtime。
 */
export function buildRereadInstructionContext(
  runtime: AgentRuntimeInternal,
  reread: InstructionSourcesReread,
  model: Model | undefined,
): ContextBuildResult | undefined {
  const snapshot = runtime.contextSourceSnapshot;
  if (!snapshot) return undefined;
  return runtime
    .createContextBuilderFromSnapshot(
      { ...snapshot, userInstructions: reread.userInstructions },
      runtime.memoryRoot,
      { memoryIndexContent: reread.memoryIndex?.content, model, persistEnvInfo: false },
    )
    .build();
}

/**
 * compaction 提交后采用重读的内容：更新 context 快照与 Memory 索引，按它重建公告来源，
 * 指令增量的 reason 改为 compaction。不改历史里的 system 前缀，也不改工作目录、环境与 Git 预取标记。
 * 修复原因：原来重读结果在 compact 落库之前就交给 runtime；compact 失败或取消时 runtime 已持有新内容，
 * 历史里却还是旧公告，下一次请求以 session_start 为原因宣告这次变化。
 */
export function applyRereadInstructionSources(
  runtime: AgentRuntimeInternal,
  reread: InstructionSourcesReread,
  model: Model | undefined,
): void {
  const snapshot = runtime.contextSourceSnapshot;
  if (!snapshot) return;
  runtime.contextSourceSnapshot = { ...snapshot, userInstructions: reread.userInstructions };
  runtime.memoryIndexContent = reread.memoryIndex?.content;
  runtime.unreadableInstructionPaths = new Set(reread.unreadablePaths);
  runtime.contextBuilder = runtime.createContextBuilderFromSnapshot(
    runtime.contextSourceSnapshot,
    runtime.memoryRoot,
    { memoryIndexContent: runtime.memoryIndexContent, model },
  );
  runtime.latestContextBuildResult = runtime.contextBuilder.build();
  runtime.instructionRefreshReason = "compaction";
}

export function logMemorySkipped(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
  reason: string,
  context: Record<string, unknown> = {},
): void {
  this.logger?.debug("Memory read skipped", {
    ...traceContextToLogContext(traceContext),
    event: "memory.read.skipped",
    module: "core.runtime",
    reason,
    status: "completed",
    ...context,
  });
}

export async function discoverSkillsForContext(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<SkillLoadOutcome | undefined> {
  if (!this.skillPort) {
    return undefined;
  }

  try {
    const outcome = await this.skillPort.discoverSkills({
      // 技能发现根 = **工作区级根**：项目技能根是 `<工作区>/.zcodium/skills`，config 里
      // `skills.roots` 的相对项也按它解析（adapters 的 resolveProjectSkillDirectories 在没有
      // `.git` 时只取传入目录本身）。用执行 cwd 会让对话会话把技能根落到会话目录，
      // 工作区级 skills 静默失效；CLI/TUI 没有 workspacePath 时必须继续跟随当前执行 cwd
      // （改动前就是它）。见 docs/specs/conversation-session-workspace.md 规则 9。
      workingDirectory: workspaceLevelRootOf(this),
      trace: traceContext,
    });
    this.logger?.debug("Skills discovered", {
      ...traceContextToLogContext(traceContext),
      diagnosticCount: outcome.diagnostics.length,
      module: "core.runtime",
      skillCount: outcome.skills.length,
      totalDiscovered: outcome.totalDiscovered,
    });
    return outcome;
  } catch (error) {
    this.logger?.warn("Skill discovery failed", {
      ...traceContextToLogContext(traceContext),
      error: error instanceof Error ? error.message : String(error),
      module: "core.runtime",
    });
    return {
      skills: [],
      diagnostics: [
        {
          code: "skill_scan_failed",
          severity: "warning",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
      totalDiscovered: 0,
    };
  }
}

export function createConfigOnlyContextSnapshot(
  this: AgentRuntimeInternal,
  workingDirectory: string,
): ContextSourceSnapshot {
  return {
    workingDirectory,
    envInfo: this.config.envInfo ?? {
      cwd: workingDirectory,
      platform: "unknown",
      shell: "unknown",
      osVersion: "unknown",
      nodeVersion: "unknown",
    },
    currentDate: this.config.currentDate,
    projectContext: this.config.projectContext,
    diagnostics: [],
  };
}

export function initializeMessageHistoryFromContext(
  this: AgentRuntimeInternal,
  contextBuilder: ContextBuilder,
  traceContext: TraceContext,
): void {
  const contextResult = contextBuilder.build();
  this.latestContextBuildResult = contextResult;
  this.messageHistory.init(buildContextHistoryEntries(contextResult));

  this.logger?.debug("Context built", {
    ...traceContextToLogContext(traceContext),
    event: "context.built",
    module: "core.runtime",
    sectionCount: contextResult.sections.length,
    status: "completed",
    tokenMethod: "estimated",
    tokenizer: "zcode.estimateTokens.v1",
    totalChars: contextResult.totalChars,
    totalTokens: contextResult.totalTokens,
    sections: contextResult.sections.map((s) => ({
      name: s.name,
      source: s.source,
      chars: s.chars,
      tokens: s.tokens,
      tokenMethod: "estimated",
      confidence: "medium",
      tokenizer: "zcode.estimateTokens.v1",
      preview: s.preview,
      content: s.content,
    })),
  });
}
