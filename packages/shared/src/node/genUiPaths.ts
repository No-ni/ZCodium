import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { buildGenUiScopeKey, genUiScopeSchema, type GenUiScope } from "../gen-ui/index.js";
import { isManagedConversationWorkspace } from "./conversationWorkspaceEnv.js";

/** Execution Host supplies this process-scoped root; models never choose it. */
export const GEN_UI_OUTPUT_ROOT_ENV = "ZCODE_GEN_UI_OUTPUT_ROOT";
export const GEN_UI_OUTPUT_DIRECTORY = "visualizations";

export function getGenUiOutputDirectory(
  outputRoot: string,
  scope: GenUiScope,
  conversation?: { conversationWorkspaceRoot: string; executionWorkspacePath?: string },
): string {
  genUiScopeSchema.parse(scope);
  if (!isAbsolute(outputRoot) || !isAbsolute(scope.workspacePath))
    throw new Error("Gen UI output root and workspace must be absolute");
  const executionPath = conversation?.executionWorkspacePath;
  if (
    conversation &&
    isManagedConversationWorkspace(
      scope.workspacePath,
      scope.workspaceIdentity,
      conversation.conversationWorkspaceRoot,
    ) &&
    executionPath
  ) {
    if (!isAbsolute(executionPath)) throw new Error("Gen UI execution directory must be absolute");
    const child = relative(resolve(scope.workspacePath), resolve(executionPath));
    const isLegacyRoot =
      resolve(scope.workspacePath) === resolve(conversation.conversationWorkspaceRoot);
    // 原因：task 已有独立 cwd，可直接放产物；旧 default 只有分配子 cwd 后才可本地输出。
    // 派生 actor 若继承根外 cwd 仍用全局输出，不能因此扩大 Host 文件授权。
    if (
      (!isLegacyRoot || child) &&
      child !== ".." &&
      !child.startsWith(`..${sep}`) &&
      !isAbsolute(child)
    )
      return join(executionPath, GEN_UI_OUTPUT_DIRECTORY);
  }
  const root = resolve(outputRoot);
  const child = relative(resolve(scope.workspacePath), root);
  // 根因：项目内输出会制造 Git diff；生成目录由执行端宿主提供，不能再回退到工作区。
  if (!child || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)))
    throw new Error("Gen UI output root must be outside the workspace");
  return join(root, createHash("sha256").update(buildGenUiScopeKey(scope)).digest("hex"));
}
