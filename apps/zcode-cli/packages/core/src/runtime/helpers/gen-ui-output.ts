import { getGenUiOutputDirectory } from "@zcode/shared/node";
import type { AgentRuntimeInternal } from "../internal.js";
import { workspaceScopeRootOf } from "./workspace-scope.js";

/**
 * 会话的 Gen UI 输出目录；fork 时传子会话 id，取子会话自己的目录。
 * fork 到另一个 cwd 时保持项目 workspace 身份，只把子执行目录传给对话专属输出布局。
 * 原上游将 cwd 当身份路径，会与本仓子 runtime 的目录计算分叉。
 */
export function resolveGenUiOutputDirectory(
  runtime: AgentRuntimeInternal,
  sessionId: string = runtime.sessionId,
  workspacePath: string = workspaceScopeRootOf(runtime),
  executionWorkspacePath: string = runtime.workspaceRoot,
): string | undefined {
  if (runtime.config.presentationSurface !== "zcode_desktop" || !runtime.config.genUiOutputRoot)
    return undefined;
  return getGenUiOutputDirectory(
    runtime.config.genUiOutputRoot,
    {
      // 工作区级读点统一走唯一入口：不再各自写一份 `config.workspacePath ?? workspaceRoot` 回落，
      // 否则将来任何一侧的口径变化都会在这里分叉。
      workspacePath,
      workspaceIdentity: runtime.config.workspaceIdentity,
      sessionId,
    },
    runtime.config.conversationWorkspaceRoot
      ? {
          conversationWorkspaceRoot: runtime.config.conversationWorkspaceRoot,
          // workspaceRoot 是会话初始执行边界，不随 Bash cd 漂移；与 CLI record 的投影同源。
          executionWorkspacePath,
        }
      : undefined,
  );
}

export async function ensureGenUiOutputDirectory(runtime: AgentRuntimeInternal): Promise<void> {
  const path = resolveGenUiOutputDirectory(runtime);
  if (!path) return;
  if (!runtime.fileSystemPort) throw new Error("Gen UI output requires FileSystemPort");
  // 只有成功创建后才向模型声明可写目录；失败不能静默落到 Git 工作区。
  await runtime.fileSystemPort.createDirectory({ path, trace: runtime.rootTraceContext });
}
