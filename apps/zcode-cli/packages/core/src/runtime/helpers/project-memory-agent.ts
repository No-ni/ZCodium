import type { Model, ModelInputMessage, ModelToolContract, TraceContext } from "../deps.js";
import type { ModelApiOperation } from "@zcode/contracts";
import {
  PermissionService,
  createDenyPermissionBroker,
  createToolExecutor,
  defaultPermissionConfig,
  traceContextToLogContext,
} from "../deps.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { ReadFileStateMap } from "../../tool/types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { getSessionShellSelectionFromConfig } from "../methods/session-shell-environment.js";
import { buildRuntimeProviderRequestMessages } from "./runtime-provider-request-messages.js";
import { createRuntimeModel, withModelInvocationContext } from "../methods/runtime-model.js";
import { workspaceLevelRootOf } from "./workspace-scope.js";

export interface ProjectMemoryAgentContext {
  memoryRoot: string;
  providerEntries: readonly RuntimeMessageEntry[];
  midConversationSystem: AgentRuntimeInternal["config"]["midConversationSystem"];
  model: Model;
  operation: ModelApiOperation;
  readFileState: ReadFileStateMap;
  tools: readonly ModelToolContract[];
  traceContext: TraceContext;
  workingDirectory: string;
  workspaceRoot: string;
}

export function captureProjectMemoryAgentContext(
  runtime: AgentRuntimeInternal,
  input: {
    memoryRoot: string;
    /** Extraction 继承产生该工作的 Turn Model。 */
    model?: Model;
    operation: ModelApiOperation;
    traceContext: TraceContext;
  },
): ProjectMemoryAgentContext {
  const baseModel =
    input.model ??
    createRuntimeModel(runtime, {
      selection: runtime.getSessionModelSelection(),
    });
  const model = withModelInvocationContext(baseModel, () => ({
    metadata: {
      ...traceContextToLogContext(input.traceContext),
      querySource: input.operation,
    },
    modelRequestSessionType: "other",
    modelCall: { operation: input.operation },
    traceContext: input.traceContext,
  }));
  return {
    memoryRoot: input.memoryRoot,
    // Extraction 会跨异步边界消费这份成员浅快照；它依赖 RuntimeMessageEntry
    // 进入 MessageHistory 后保持不可变。后续只能 append、整体 replace 或 copy-on-write，
    // 禁止原地修改共享的 entry/message/content，否则会污染已调度的 Memory 上下文。
    providerEntries: [...runtime.messageHistory.borrowReadOnlyRuntimeEntries()],
    midConversationSystem: runtime.config.midConversationSystem,
    model,
    operation: input.operation,
    readFileState: new Map(runtime.readFileState),
    tools: runtime.getTools(model).map((tool) => ({ ...tool })),
    traceContext: input.traceContext,
    workingDirectory: runtime.workingDirectory,
    workspaceRoot: runtime.workspaceRoot,
  };
}

export function buildProjectMemoryAgentProviderMessages(
  runtime: AgentRuntimeInternal,
  context: ProjectMemoryAgentContext,
  prompt: string,
): ModelInputMessage[] {
  const entries: RuntimeMessageEntry[] = [
    ...context.providerEntries,
    { message: { content: prompt, role: "user" } },
  ];
  return buildRuntimeProviderRequestMessages(
    {
      config: { midConversationSystem: context.midConversationSystem },
    },
    { applyCacheControl: true, entries, model: context.model },
  ).messages;
}

export function createProjectMemoryAgentToolExecutor(
  runtime: AgentRuntimeInternal,
  context: ProjectMemoryAgentContext,
) {
  return createToolExecutor({
    artifactStore: runtime.artifactStore,
    emitEvent: async () => {},
    executionPort: runtime.executionPort,
    fileSystemPort: runtime.fileSystemPort,
    getBashShellSelection: () => getSessionShellSelectionFromConfig(runtime.config),
    getMode: () => "yolo",
    getMemoryRoot: () => context.memoryRoot,
    getWorkingDirectory: () => context.workingDirectory,
    getWorkspaceRoot: () => context.workspaceRoot,
    // 工作区级根必须显式给：缺了它 tool/executor/impl.ts 的回落链会退化成 getWorkspaceRoot
    // （冻结的执行边界），memory 抽取里的 workspace 级读点（workflow 定义与草稿、skills 发现、
    // 草稿免确认闸门）就与主 runtime 的 `workspaceLevelRootOf` 不一致——CLI/TUI 里 Bash `cd`
    // 之后主链跟随当前执行 cwd，抽取链却停在启动目录。
    //
    // 这里**不能**用 `workspaceScopeRootOf`：那个是身份（projectID / 项目记忆根 / MCP 连接身份），
    // 而本字段的语义是「工作区级产物落在哪」，与主链同源。
    getWorkspaceScopeRoot: () => workspaceLevelRootOf(runtime),
    imageProcessorPort: runtime.imageProcessorPort,
    pdfDocumentPort: runtime.pdfDocumentPort,
    maxConcurrency: runtime.config.toolConcurrency?.maxConcurrency,
    model: context.model,
    permissionBroker: createDenyPermissionBroker(),
    permissionService: new PermissionService(defaultPermissionConfig),
    // Memory agent 必须继承 Main 已完成的 Read；否则 provider context 说文件已读，
    // Edit 执行边界却会拒绝同一文件，和基线的 cloned tool context 不一致。
    readFileState: new Map(context.readFileState),
    registry: runtime.registry,
    runtimeScope: "main",
    sessionId: runtime.sessionId,
    sessionStore: runtime.sessionStore,
    skillPort: runtime.skillPort,
    traceContext: context.traceContext,
  });
}
