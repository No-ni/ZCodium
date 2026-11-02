import {
  selectActiveConversationBranch,
  traceContextToLogContext,
  type TraceContext,
} from "../deps.js";
import {
  buildMemoryExtractionPrompt,
  createMemoryExtractionScheduler,
  type MemoryExtractionScheduler,
  type MemoryExtractionSnapshot,
} from "../../memory/extraction.js";
import { runMemoryAgentLoop } from "../../memory/memory-agent-loop.js";
import { scanMemoryManifest } from "../../memory/recall/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { resolveSummaryModel } from "./summary-model.js";
import { withModelInvocationContext } from "../methods/runtime-model.js";
import {
  captureProjectMemoryAgentContext,
  createProjectMemoryAgentToolRunner,
  projectMemoryAgentEntries,
  renderProjectMemoryAgentRequest,
  type ProjectMemoryAgentContext,
} from "./project-memory-agent.js";
import { resolveEnabledProjectMemoryRoot } from "./project-memory.js";
import { workspaceScopeRootOf } from "./workspace-scope.js";
import { isToolSearchControlName } from "./tool-search-controls.js";

const EXTRACTION_MAX_TURNS = 5;
const EXTRACTION_DRAIN_TIMEOUT_MS = 60_000;

interface ProjectMemoryExtractionSnapshot
  extends MemoryExtractionSnapshot, ProjectMemoryAgentContext {
  reasoningLevel?: string;
}

export type ProjectMemoryExtractionScheduler =
  MemoryExtractionScheduler<ProjectMemoryExtractionSnapshot>;

export function isProjectMemoryEnabled(this: AgentRuntimeInternal): boolean {
  return resolveEnabledProjectMemoryRoot(this.config, workspaceScopeRootOf(this)) !== undefined;
}

export function scheduleProjectMemoryExtraction(
  runtime: AgentRuntimeInternal,
  input: { model: ProjectMemoryAgentContext["model"]; traceContext: TraceContext },
): void {
  if (runtime.shuttingDown) return;
  // 原因：headless 只关闭自动 Extraction，必须在读取快照或访问文件前返回，避免后台副作用。
  if (runtime.config.memory?.extractionEnabled === false) return;
  // Bash cd 只改变执行 cwd，project Memory 身份必须继续使用工作区键路径
  // （对话会话的执行 cwd 是会话独立目录，用它会让每个会话各建一份记忆）。
  const memoryRoot = resolveEnabledProjectMemoryRoot(runtime.config, workspaceScopeRootOf(runtime));
  if (!memoryRoot) return;
  if (runtime.isRemoteWorkspace()) return;
  if (!runtime.sessionStore || !runtime.fileSystemPort) return;

  const snapshotBase = captureProjectMemoryAgentContext(runtime, {
    memoryRoot,
    model: input.model,
    operation: "project_memory_extract",
    traceContext: input.traceContext,
  });
  const snapshotBoundaryMessageId = runtime.latestConversationMessageId;
  if (!snapshotBoundaryMessageId) return;
  const durableMessages = runtime.sessionStore.messages({ sessionID: runtime.sessionId });
  const session = runtime.sessionStore.getSession(runtime.sessionId);
  // 「总结模型」在调度边界现拉：改设置后已创建的会话下一次 Extraction 即生效。
  // 回退必须保留快照的 extraction 上下文，不能拿原始 Turn Model 覆盖它。
  const summaryModel = resolveSummaryModel(runtime, {
    fallback: snapshotBase.model,
    operation: "project_memory_extract",
    traceContext: input.traceContext,
  });
  const snapshot = Promise.all([durableMessages, session, summaryModel]).then(
    ([messages, scheduledSession, resolvedModel]): ProjectMemoryExtractionSnapshot => {
      const activeMessages = selectActiveConversationBranch(messages, {
        branchCutAfterMessageId: scheduledSession?.revert?.branchCutAfterMessageID,
        rewindCreatedMessageId: scheduledSession?.revert?.createdMessageID,
        rewindKeptMessageIds: scheduledSession?.revert?.keptMessageIDs,
        rewindTargetMessageId: scheduledSession?.revert?.targetMessageID,
      });
      const boundaryIndex = activeMessages.findIndex(
        (message) => message.info.id === snapshotBoundaryMessageId,
      );
      if (boundaryIndex < 0) {
        throw new Error("Extraction boundary is missing from the scheduled active branch");
      }
      return {
        ...snapshotBase,
        ...(resolvedModel && resolvedModel !== snapshotBase.model
          ? {
              // 偏好等级随调度快照冻结，Memory 每轮请求不再降为最低档。
              reasoningLevel: resolvedModel.options.reasoningLevel,
              // 换用「总结模型」时工具契约的媒体能力投影也要跟着换，
              // 否则 provider 看到的工具目录仍按当轮 Turn Model 的能力声明。
              model: withModelInvocationContext(resolvedModel, () => ({
                metadata: {
                  ...traceContextToLogContext(input.traceContext),
                  querySource: "project_memory_extract",
                },
                modelRequestSessionType: "other",
                modelCall: { operation: "project_memory_extract" },
                traceContext: input.traceContext,
              })),
              tools: runtime
                .getTools(resolvedModel)
                .filter((tool) => !isToolSearchControlName(tool.name))
                .map((tool) => ({ ...tool })),
            }
          : {}),
        boundaryMessageId: snapshotBoundaryMessageId,
        durableMessages: activeMessages.slice(0, boundaryIndex + 1),
      };
    },
  );

  runtime.memoryExtractionScheduler ??= createMemoryExtractionScheduler((extraction) =>
    executeProjectMemoryExtraction(runtime, extraction),
  );
  runtime.memoryExtractionScheduler.schedule(snapshot);
}

export async function drainMemoryExtractions(
  this: AgentRuntimeInternal,
  timeoutMs: number | null = EXTRACTION_DRAIN_TIMEOUT_MS,
): Promise<void> {
  const scheduler = this.memoryExtractionScheduler;
  if (!scheduler) return;
  // Runtime 关闭与 benchmark 等待真实收尾；对外关闭期限由 App 管理，不在这里提前放行。
  if (timeoutMs === null) {
    await scheduler.drain();
    return;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      scheduler.drain(),
      new Promise<void>((_resolve, reject) => {
        // 到期只是停止等待；不能向 session 生命周期谎报资源已经释放。
        timeout = setTimeout(
          () => reject(new Error("Memory extraction drain timed out")),
          timeoutMs,
        );
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function executeProjectMemoryExtraction(
  runtime: AgentRuntimeInternal,
  input: {
    abortSignal: AbortSignal;
    messageCount: number;
    snapshot: ProjectMemoryExtractionSnapshot;
  },
) {
  const startedAt = performance.now();
  let status: "success" | "aborted" | "error" = "success";
  try {
    const manifest = await scanMemoryManifest({
      fileSystem: runtime.fileSystemPort!,
      rootDir: input.snapshot.memoryRoot,
      signal: input.abortSignal,
    });
    if (input.abortSignal.aborted) {
      status = "aborted";
      return "aborted" as const;
    }
    const prompt = buildMemoryExtractionPrompt({
      manifest,
      messageCount: input.messageCount,
    });
    await runMemoryAgentLoop({
      abortSignal: input.abortSignal,
      // 合并依据：Memory 与 Main 共用逐轮投影和批次结算，不能接回已退休的单工具循环。
      entries: projectMemoryAgentEntries(input.snapshot, prompt),
      renderRequest: (entries) => renderProjectMemoryAgentRequest(input.snapshot, entries),
      executeToolCalls: createProjectMemoryAgentToolRunner(runtime, input.snapshot),
      registry: runtime.registry,
      maxTurns: EXTRACTION_MAX_TURNS,
      model: input.snapshot.model,
      reasoningLevel: input.snapshot.reasoningLevel,
      rootDir: input.snapshot.memoryRoot,
      workingDirectory: input.snapshot.workingDirectory,
      workspaceRoot: input.snapshot.workspaceRoot,
    });
    return "success" as const;
  } catch (error) {
    if (input.abortSignal.aborted || isAbortError(error)) {
      status = "aborted";
      return "aborted" as const;
    }
    status = "error";
    return "error" as const;
  } finally {
    try {
      runtime.logger?.info("Memory extraction completed", {
        event: "runtime.memory_extraction.completed",
        operation: "project_memory_extract",
        status: status === "success" ? "completed" : status === "aborted" ? "cancelled" : "failed",
        durationMs: performance.now() - startedAt,
      });
    } catch {
      // 日志失败不改变后台提取结果。
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
