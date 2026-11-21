/** 兼容公开入口；声明按职责由内部叶文件唯一提供。 */
export type {
  DynamicWorkflowRunSubmitRequest,
  DynamicWorkflowRunSubmitOptions,
  DynamicWorkflowRunSubmitResult,
  DynamicWorkflowRunAmendRequest,
  DynamicWorkflowRunAmendRefusalReason,
  DynamicWorkflowRunAmendResult,
  DynamicWorkflowRunCancelInitiator,
} from "./dynamic-workflow-run-requests.js";
export {
  DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORTS,
  DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORT_BYTES,
} from "./dynamic-workflow-run-snapshot.js";
export type { DynamicWorkflowRunSnapshot } from "./dynamic-workflow-run-snapshot.js";
export type {
  DynamicWorkflowRunArtifactVersion,
  DynamicWorkflowRunArtifactKind,
  DynamicWorkflowRunArtifact,
  DynamicWorkflowRunArtifactItem,
  DynamicWorkflowRunArtifactItemPage,
  DynamicWorkflowRunArtifactItemsResult,
  DynamicWorkflowRunArtifactBytes,
} from "./dynamic-workflow-run-artifacts.js";
export type {
  DynamicWorkflowRunPendingQuestion,
  DynamicWorkflowResolveQuestionRefusalReason,
  DynamicWorkflowResolveQuestionResult,
  DynamicWorkflowRunLifecycleStatus,
  DynamicWorkflowRunStopReason,
} from "./dynamic-workflow-run-state.js";
export type {
  DynamicWorkflowRunWaitOptions,
  DynamicWorkflowRunEventPage,
  DynamicWorkflowRunEventsResult,
  DynamicWorkflowRunEvent,
} from "./dynamic-workflow-run-event-query.js";
export type { DynamicWorkflowRunPort } from "./dynamic-workflow-run-access.js";
export type {
  DynamicWorkflowRunListQuery,
  DynamicWorkflowRunSummary,
  DynamicWorkflowRunListItem,
  DynamicWorkflowRunListResult,
  DynamicWorkflowRunUsage,
  DynamicWorkflowRunActor,
  DynamicWorkflowRunLogEntry,
  DynamicWorkflowRunDetail,
  DynamicWorkflowRunSessionSummary,
} from "./dynamic-workflow-run-detail.js";

export type {
  DynamicWorkflowRunError,
  DynamicWorkflowRunProviderStop,
} from "./dynamic-workflow-run-error.js";

export {
  DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS,
  boundDynamicWorkflowRunEventPayload,
} from "../protocol-values/contract.js";

/**
 * workflow run 里**任意脚本值**（顶层返回的产物、`report(item)` 的条目）→ 给模型或读者看的
 * 文本。实现已随共享 workflowRuns reducer 搬进 `@zcode/shared/zcode-protocol-v4`
 * （workflow-artifact.ts，规则与来龙去脉见那边的注释）：`reports[].preview` 的归约下沉到
 * shared 后成了第四个消费者，而依赖方向是 contracts → shared，只能函数跟着搬。这里保留
 * re-export，既有的三个消费者（完成通知、TaskOutput 的 resultText、v4 投影）一行不改。
 */
export { serializeWorkflowArtifact } from "@zcode/shared/zcode-protocol-v4";

// 情势截面（阶段 / 子代理 / 健康）的类型住在 dynamic-workflow-run-roster.port.ts（同上），
// 此处原样再导出以保持 `@zcode/contracts` 的导入路径不变。
export type * from "./dynamic-workflow-run-roster.port.js";

// retune（就地改在飞 run 的并发上界）的三个类型住在 dynamic-workflow-run-retune.port.ts，
// 同上原样再导出。
export type * from "./dynamic-workflow-run-retune.port.js";

// 工作区 transcript 的六个类型住在 dynamic-workflow-run-workspace.port.ts，同上原样再导出。
export type * from "./dynamic-workflow-run-workspace.port.js";

// 留白（快照条目、fillHole 的请求 / 结果）的类型住在 dynamic-workflow-run-hole.port.ts，同一条拆分先例。
export type * from "./dynamic-workflow-run-hole.port.js";

export type * from "./dynamic-workflow-run-resume.port.js";
