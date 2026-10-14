import { useCallback } from "react";
import type { ZCodeSavedWorkflowRun } from "@zcode/shared";
import type {
  SavedWorkflowsOpenArtifactParams,
  SavedWorkflowsOpenRunParams,
} from "@/settings/saved-workflows/savedWorkflowContract.js";

/** 一行运行记录归属的项目（项目档恒定，全局档按 `workspacePath ?? cwd` 反查）。 */
interface SavedWorkflowRunOpenTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

export function buildSavedWorkflowRunOpenParams(
  run: ZCodeSavedWorkflowRun,
  workflowName: string,
  target: SavedWorkflowRunOpenTarget,
  sessionId: string,
  toolCallId: string,
): SavedWorkflowsOpenRunParams {
  return {
    sessionId,
    runId: run.runId,
    toolCallId,
    workflowName,
    workspacePath: target.workspacePath,
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
    fileReferenceRootPath: run.cwd?.trim() || target.workspacePath,
  };
}

export function buildSavedWorkflowArtifactOpenParams(
  run: ZCodeSavedWorkflowRun,
  artifactId: string,
  target: SavedWorkflowRunOpenTarget,
  sessionId: string,
): SavedWorkflowsOpenArtifactParams {
  const artifact = run.artifacts?.find((candidate) => candidate.id === artifactId);
  return {
    sessionId,
    runId: run.runId,
    artifactId,
    ...(artifact?.title === undefined ? {} : { title: artifact.title }),
    ...(artifact?.contentType === undefined ? {} : { contentType: artifact.contentType }),
    workspacePath: target.workspacePath,
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
    fileReferenceRootPath: run.cwd?.trim() || target.workspacePath,
  };
}

/**
 * 中枢运行历史行上两个「打开」的门与实参构造。
 *
 * ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 发布给用户看的产出，不是脚本的顶层返回值。
 *
 * 抽成一个 hook 而不是在两个组里各写一遍：项目档与全局档唯一的差别是**目标项目怎么算**
 * （前者恒定，后者按 `run.workspacePath ?? run.cwd` 反查已打开项目），而两个门的判据必须一致——它们各写一遍时，
 * 「产物不需要 toolCallId」这条会很自然地在其中一处被写成「和查看实例一样」。
 *
 * ```
 *                       parentSessionId?   toolCallId?   项目可打开?
 * 「查看实例」              必需              必需            必需
 * 产物 chip                必需              —              必需
 * ```
 *
 * `toolCallId` 只服务于 run 详情页里那张静态因果图（它挂在那条 CreateWorkflow 工具行的
 * display 上）。产物 tab 不画图，所以老行缺 `toolCallId` 时产物仍然打得开。
 */
export function useSavedWorkflowRunOpeners(options: {
  /** 该行归属的项目；返回 null 即两个入口都关闭（全局档里对应的项目没打开）。 */
  resolveTarget: (run: ZCodeSavedWorkflowRun) => SavedWorkflowRunOpenTarget | null;
  onOpenWorkflowRun?: (params: SavedWorkflowsOpenRunParams) => void;
  onOpenWorkflowArtifact?: (params: SavedWorkflowsOpenArtifactParams) => void;
}): {
  handleOpenRun: (run: ZCodeSavedWorkflowRun, workflowName: string) => void;
  handleOpenArtifact: (run: ZCodeSavedWorkflowRun, artifactId: string) => void;
} {
  const { onOpenWorkflowArtifact, onOpenWorkflowRun, resolveTarget } = options;

  const handleOpenRun = useCallback(
    (run: ZCodeSavedWorkflowRun, workflowName: string) => {
      const sessionId = run.parentSessionId;
      const toolCallId = run.toolCallId;
      if (!sessionId || !toolCallId) return;
      const target = resolveTarget(run);
      if (!target) return;
      onOpenWorkflowRun?.(
        buildSavedWorkflowRunOpenParams(run, workflowName, target, sessionId, toolCallId),
      );
    },
    [onOpenWorkflowRun, resolveTarget],
  );

  const handleOpenArtifact = useCallback(
    (run: ZCodeSavedWorkflowRun, artifactId: string) => {
      const sessionId = run.parentSessionId;
      if (!sessionId) return;
      const target = resolveTarget(run);
      if (!target) return;
      // 行上的 chip 载荷带最新版 contentType；旧行缺少 artifacts 时仍可打开产物 tab。
      onOpenWorkflowArtifact?.(
        buildSavedWorkflowArtifactOpenParams(run, artifactId, target, sessionId),
      );
    },
    [onOpenWorkflowArtifact, resolveTarget],
  );

  return { handleOpenArtifact, handleOpenRun };
}
