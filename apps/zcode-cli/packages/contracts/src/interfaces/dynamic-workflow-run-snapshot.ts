import type { DynamicWorkflowRunError } from "./dynamic-workflow-run-error.js";
import type { DynamicWorkflowRunHole } from "./dynamic-workflow-run-hole.port.js";
import type { WorkflowTaskSnapshot } from "./workflow.port.js";
import type {
  DynamicWorkflowRunLifecycleStatus,
  DynamicWorkflowRunStopReason,
  DynamicWorkflowRunPendingQuestion,
} from "./dynamic-workflow-run-state.js";
import type { DynamicWorkflowRunArtifact } from "./dynamic-workflow-run-artifacts.js";

/**
 * 终态快照带的 report item 上限（`reports` 的长度上界）。取 256——report 条数上限从 256 提到
 * 65,536 之前的值：报告条数不超过它的 run，快照与通知逐字节不变；更大的 run 由 `reportCount`
 * 说出真实总数。完成通知那一节的字符预算（8000）本来也容不下更多条。
 */
export const DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORTS = 256;

/**
 * 终态快照带的 report item 的字节上界（按 journal 里 `result_json` 的字节计）。取 8 MiB——
 * 单条上限 32 KiB 时 256 条的最坏情形，所以单条上限提到 1 MiB 之后快照的内存不涨。快照只喂
 * 完成通知，而通知每条最多展示 2,000 字符、整节 8,000 字符，8 MiB 远超它能用上的部分。
 * 第一条总是带上，所以一条 1 MiB 的报告不会让快照一条都不带。
 */
export const DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORT_BYTES = 8 * 1024 * 1024;

/**
 * run 快照：沿用 {@link WorkflowTaskSnapshot} 的形状（后台任务追踪器与通知管线按它读），
 * 只把 `output` 放宽——workflow run 的产物是脚本的顶层返回值，形状由脚本决定，不是 legacy
 * `Workflow` 工具的输出类型。legacy 端口本身不加宽（两套 workflow 机制不共用端口）。
 *
 * `reports` 是脚本 `report(item)` 交出的渐进产物**原值**，按报告顺序，来自 journal 的
 * `kind = "report"` 节点行——那是这些条目的持久家（`workflowRuns.reports` 只是有界的
 * memory-only 展示面）。完成通知据此在 completed / failed / cancelled 三态下一律回投：
 * 一个死在第 12 个 ask 上的 run 仍然做完了 11 个 ask 的活，捞回它正是 `report` 存在的理由。
 * 它只带**前** {@link DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORTS} 条、且至多
 * {@link DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORT_BYTES} 字节；真实总数在 `reportCount`
 * （docs/execution-engine.md「Reading the journal」）。
 */
export type DynamicWorkflowRunSnapshot = Omit<WorkflowTaskSnapshot, "output"> & {
  output?: unknown;
  /**
   * run 的真实终态词。基类的 `status` 是后台任务
   * 追踪器的通用词汇（`stopped` 折成 `cancelled`、`errored` 折成 `failed`），通知与工具文案
   * 要说真话必须读这两个字段；`stopReason` 只在 `runStatus === "stopped"` 时在场。
   */
  runStatus?: DynamicWorkflowRunLifecycleStatus;
  stopReason?: DynamicWorkflowRunStopReason;
  /** 发起这个 run 的会话（journal 的 parent_session_id；注册表条目在场时取它的）。 */
  parentSessionId?: string;
  /**
   * 引擎是不是在本进程手里，只对未终态的 run 在场。为假时 journal 说它在跑，引擎却在别的进程
   * （或死进程）：这里补不了它的留白，也修订不了它，FillWorkflowHole 与 AmendWorkflow 据此在开窗前拒绝。
   */
  liveInThisProcess?: boolean;
  /** 本 run 修订自哪个 run；不是修订则缺席。 */
  resumedFrom?: string;
  /** 本 run 被哪次修订停下并替代；未被替代则缺席。 */
  supersededBy?: string;
  /**
   * 本 run 自己的并发上界（`dwf_run.caps_max_concurrency`），**只在低于当前天花板时在场**：
   * 跑在天花板上的 run 没有可说的（「无则缺席」，与 `reports` 同规）。`AmendWorkflow` 的
   * `resolveInput` 据它决定省略 `max_concurrency` 时沿用什么。
   */
  maxConcurrency?: number;
  /**
   * 本 run 的子代理模型（journal 事件 `run-launched` 上的那一个），规范形
   * `providerId/modelId[$reasoningLevel]`，**只在设过时在场**：继承会话模型的 run 没有可说的
   * （「无则缺席」，与 `maxConcurrency` 同规）。
   * 这里是字符串而不是 {@link ModelSelection}：读面只用来显示与原样回填，没有人按字段取值。
   */
  subagentModel?: string;
  /** Latest durable bindings, including atomic hole-filled updates. */
  modelBindings?: Record<string, string>;
  /**
   *
   * 终态通知据它把「改好脚本再内联提交」换成「就地编辑那个文件、再 `path` 修订」，所以已确认同步时可
   * 从快照读到；用户面一概不显示（与 `subagentModel` 不同，后者会进桌面的 run 面板）。
   */
  scriptPath?: string;
  /** 结构化失败（与 {@link DynamicWorkflowRunDetail.error} 同源）；基类的 `error` 是它的 message。 */
  failure?: DynamicWorkflowRunError;
  /**
   * 本 run 及其 lineage 的**活动**时长（毫秒）：本 run 的每一世加上每个前驱的每一世，世与世
   * 之间的空档不计。完成卡的「时间」格报的就是它。
   *
   * 与 `reports` / `artifacts` 同规**只在终态在场**（`getTask` 被反复轮询，而消费者只有终态
   * 通知），且 journal 说不出话时整字段缺席——不是 0。缺席即读侧退回 `completedAt − startedAt`：
   * 那是结算它的那个进程自己看到的一世，一个更保守但永不虚报的答案。
   */
  activeDurationMs?: number;
  /** 前 {@link DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORTS} 条 report item，按报告顺序；零条时缺席。 */
  reports?: readonly unknown[];
  /**
   * 本 run 的 report 真实总条数（`count(*)`），与 `reports` 同在同缺。通知与 manifest 的
   * `count` 读它：`reports` 被截在上限处时，`count ≠ shown` 就是「还有更多」的信号。
   */
  reportCount?: number;
  /**
   * 此刻停驻在这个 run 上、等主代理作答的升级问题。
   *
   * **从内存注册表投影，不是 journal 重放**：journal 里有 `escalation-raised` 与
   * `escalation-resolved` 两类事件，但「现在还欠谁一个答案」是进程内的活事实——重放出来的
   * 未配对 raised 在进程亡故后只会说谎（停驻的 deferred 早已随进程消失，resume 会让 actor
   * 重新提问、得新 qid）。
   *
   * 这是通知被丢弃（stale branch generation / shutdown drop）之后的**查询兜底**：主代理任何
   * 时候都能经既有观察面重新发现待答问题。零条时整字段缺席（不发空数组）。
   */
  pendingQuestions?: readonly DynamicWorkflowRunPendingQuestion[];
  /**
   * 本 run 的留白（{@link DynamicWorkflowRunHole}）：到达过的每一处，等着的与补过的。与
   * `pendingQuestions` 同规——零条整字段缺席、`waiting` 从引擎的停驻表投影而不是单靠事件重放；
   * 留白通知的发射器与 `FillWorkflowHole` 的 resolveInput 都读它。
   */
  holes?: readonly DynamicWorkflowRunHole[];
  /**
   * 本 run 发布的**用户面产物**，按首次出现顺序，来自
   * journal 的 `kind = "artifact"` 行——那是版本历史的持久家（`workflowRuns.artifacts` 只带
   * 最新版元数据）。与 `reports` 同规：**只在终态**读（`getTask` 被反复轮询，而产物行的
   * 消费者是终态通知与 GetWorkflowRun）；零件时整字段缺席。
   *
   * ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 发布给用户看的产出，与本类型的 `output`
   * （脚本顶层返回值，引擎内部叫 `RunSettlement.artifact`）无关。
   */
  artifacts?: readonly DynamicWorkflowRunArtifact[];
};
