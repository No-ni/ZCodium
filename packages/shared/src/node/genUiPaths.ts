import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { buildGenUiScopeKey, genUiScopeSchema, type GenUiScope } from "../gen-ui/index.js";

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
    !scope.workspaceIdentity?.trim() &&
    conversation?.conversationWorkspaceRoot &&
    resolve(conversation.conversationWorkspaceRoot) === resolve(scope.workspacePath) &&
    executionPath &&
    resolve(executionPath) !== resolve(scope.workspacePath)
  ) {
    const child = relative(resolve(scope.workspacePath), resolve(executionPath));
    if (!isAbsolute(executionPath)) throw new Error("Gen UI execution directory must be absolute");
    // 根因：actor 可继承父 cd 到根外的 cwd；只在对话根内分配会话输出，根外沿用 Host 全局输出。
    if (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
      return join(executionPath, GEN_UI_OUTPUT_DIRECTORY);
  }
  const root = resolve(outputRoot);
  const child = relative(resolve(scope.workspacePath), root);
  // 根因：项目内输出会制造 Git diff；生成目录由执行端宿主提供，不能再回退到工作区。
  if (!child || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)))
    throw new Error("Gen UI output root must be outside the workspace");
  return join(root, createHash("sha256").update(buildGenUiScopeKey(scope)).digest("hex"));
}
