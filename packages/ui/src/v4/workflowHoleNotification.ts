import type { WorkflowNotificationMeta, WorkflowRunHole } from "@zcode/shared/zcode-protocol-v4";
import type { OpenWorkflowRunSideTabRequest } from "../lib/workspaceSidePane.js";

/**
 * 留白通知行的纯逻辑（无 React、无 DOM）。
 *
 * `hole-reached` 的模型可见通知在 run 里长这样：run 投影的 `holes[]` 说这条留白是 waiting 还是
 * filled。行不自己算状态——`holes` 缺席（run 不在活投影）就是中性的 `left`，与升级行按
 * pendingQuestions 在场性联查同一姿态。定位到时间线那一站的键就是 `siteId`（留白 id = 阶段 id）。
 */
export type WorkflowHoleNotification = Extract<WorkflowNotificationMeta, { kind: "hole" }>;

export type HoleRowState = "waiting" | "filled" | "left";

export function holeRowState(
  holes: readonly WorkflowRunHole[] | undefined,
  siteId: string,
): HoleRowState {
  if (holes === undefined) return "left";
  const hole = holes.find((candidate) => candidate.siteId === siteId);
  if (hole === undefined) return "left";
  return hole.state === "waiting" ? "waiting" : "filled";
}

/**
 * 点这一行要定位到的阶段 id：留白的站点 id 本身就是它在阶段表上的 id（一个留白就是一个阶段），
 * 宿主拿它喂 `onOpenWorkflowRun({ phaseId })`，详情页把那一站展开、把镜头带过去。
 */
export function holeLocatePhaseId(notification: WorkflowHoleNotification): string {
  return notification.siteId;
}

/** 与轮容器共用路由门；旧通知、非 workflow 来源不误入留白展示。 */
export function workflowNotificationOf(
  header:
    | {
        origin?: string;
        originMeta?: { backgroundSource?: string; workflowNotification?: WorkflowNotificationMeta };
      }
    | null
    | undefined,
): WorkflowNotificationMeta | undefined {
  return header?.origin === "backgroundResult" && header.originMeta?.backgroundSource === "workflow"
    ? header.originMeta.workflowNotification
    : undefined;
}

/** 留白沿用真正的 run 侧栏落站请求；关联不全时不能用 toast 假装定位。 */
export function workflowNotificationOpenRequest(input: {
  parentSessionId?: string;
  runId?: string;
  toolCallId?: string;
  workflowName?: string;
  phaseId?: string;
}): OpenWorkflowRunSideTabRequest | undefined {
  const { parentSessionId, runId, toolCallId, workflowName, phaseId } = input;
  if (!parentSessionId || !runId || !toolCallId) return undefined;
  return {
    parentSessionId,
    runId,
    toolCallId,
    ...(workflowName === undefined ? {} : { workflowName }),
    ...(phaseId === undefined ? {} : { phaseId }),
  };
}
