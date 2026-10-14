// 全局工作流组的纯逻辑。与组件分文件以守住 max-lines 400，
// 也便于单测这些无 React 的判定。
import { resolveWorkspaceKey, type ZCodeSavedWorkflowRun } from "@zcode/shared";
import type { ZCodeAgentSavedWorkflowTarget } from "@zcode/services";
import type { AutomationWorkspaceOption } from "@/settings/automationWorkspaceOptions.js";
import type { SavedWorkflowProjectTarget } from "@/settings/saved-workflows/savedWorkflowContract.js";
import type { SavedWorkflowRunProject } from "@/settings/saved-workflows/SavedWorkflowRunHistoryPanel.js";

/** 全局档的 RPC 载体常量：不带 workspace，services 层自选本机运行时。 */
export const GLOBAL_SAVED_WORKFLOW_TARGET: ZCodeAgentSavedWorkflowTarget = { scope: "global" };

/** 取路径末段（跨 `/` 与 `\\`），给未打开项目的运行行做兜底 label。 */
function basenameOfPath(path: string): string {
  return (
    path
      .replace(/[\\/]+$/u, "")
      .split(/[\\/]/u)
      .filter(Boolean)
      .pop() ?? path
  );
}

/** 「修订」/「通过对话创建」的落点：活动本地项目，不在候选里则第一个本地项目；都没有则 null。 */
export function resolveGlobalActionTarget(
  localProjects: readonly AutomationWorkspaceOption[],
  activeProjectKey: string | null,
): SavedWorkflowProjectTarget | null {
  const active = localProjects.find((project) => resolveWorkspaceKey(project) === activeProjectKey);
  const target = active ?? localProjects[0];
  if (!target) return null;
  return {
    workspacePath: target.workspacePath,
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
  };
}

/** 运行行的 cwd 命中哪个已打开本地项目（用绝对路径逐字比较）。 */
export function findProjectByCwd(
  localProjects: readonly AutomationWorkspaceOption[],
  cwd: string | undefined,
): AutomationWorkspaceOption | null {
  if (!cwd) return null;
  return localProjects.find((project) => project.workspacePath === cwd) ?? null;
}

/** 全局运行按父会话的工作区根找项目；老历史行才回退到实际执行 cwd。 */
export function findProjectForSavedWorkflowRun(
  localProjects: readonly AutomationWorkspaceOption[],
  run: ZCodeSavedWorkflowRun,
): AutomationWorkspaceOption | null {
  return findProjectByCwd(localProjects, run.workspacePath ?? run.cwd);
}

/**
 * 详情页运行历史每行的项目列（全局档跨项目）：workspacePath 命中已打开项目 → 该项目 label 且可「查看实例」；
 * 否则以 `basename(workspacePath ?? cwd)` 兜底、完整 cwd 挂 title、不可「查看实例」；没有路径的老行不画项目列。
 */
export function buildGlobalRunProjectResolver(
  localProjects: readonly AutomationWorkspaceOption[],
): (run: ZCodeSavedWorkflowRun) => SavedWorkflowRunProject | null {
  return (run) => {
    const workspacePath = run.workspacePath ?? run.cwd;
    if (!workspacePath) return null;
    const project = findProjectForSavedWorkflowRun(localProjects, run);
    if (project) {
      return { label: project.label, title: run.cwd ?? workspacePath, canOpen: true };
    }
    return {
      label: basenameOfPath(workspacePath),
      title: run.cwd ?? workspacePath,
      canOpen: false,
    };
  };
}
