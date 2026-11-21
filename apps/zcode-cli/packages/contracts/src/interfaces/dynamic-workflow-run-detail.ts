import type { DynamicWorkflowRunError } from "./dynamic-workflow-run-error.js";
// ============================================================
// Dynamic Workflow Run Port - dwf 引擎 run 的提交 / 观察 / 取消边界
// ============================================================
import type {
  DynamicWorkflowRunHealth,
  DynamicWorkflowRunPhaseView,
  DynamicWorkflowRunSubagentView,
} from "./dynamic-workflow-run-roster.port.js";
import type { DynamicWorkflowRunHole } from "./dynamic-workflow-run-hole.port.js";
import type {
  DynamicWorkflowRunLifecycleStatus,
  DynamicWorkflowRunStopReason,
  DynamicWorkflowRunPendingQuestion,
} from "./dynamic-workflow-run-state.js";
import type { DynamicWorkflowRunArtifact } from "./dynamic-workflow-run-artifacts.js";

/** {@link DynamicWorkflowRunPort.listRuns} 的查询袋。 */
export interface DynamicWorkflowRunListQuery {
  /**
   * 项目键，**必填**。字面等值匹配 `dwf_run.cwd`（写入侧原样落、读侧原样查）。
   * 端口不替调用方猜一个默认 cwd：工具面恒查 `context.workingDirectory`，模型无权跨项目扫库。
   */
  cwd: string;
  /** 返回条数上限，**必填**。钳制策略属于工具面（[1, 50]）；端口不做无界枚举。 */
  limit: number;
  /** 可选状态子集。缺省即不过滤；空数组即「不匹配任何状态」（回空列表）。 */
  statuses?: readonly DynamicWorkflowRunLifecycleStatus[];
}

/**
 * 列表与详情**共同的截面**。标签、归属标注与时间戳三者在两条读面上必须逐字段同源——
 * 同一个 run 在列表里和详情里显示不同的名字或归属，是最难被测试抓住、又最直接损害信任的
 * 那类不一致。所以这里是一个共享的基接口，而不是两份各自演化的字段表。
 */
export interface DynamicWorkflowRunSummary {
  runId: string;
  /**
   * 展示标签。**已烹熟**：实现侧（run service）按 name → 脚本首行 → runId 的顺序派生好，
   * 消费方直接展示。之所以不把原料（name / scriptText）交出去让工具层自己拼：那条兜底链
   * 是读时启发式，两个工具各拼一次就会漂移，而 scriptText 是端口上最大的一个字符串
   * （列表面根本不该为了取首行把 50 份脚本搬过边界）。
   */
  label: string;
  /** 标签来源：`"name"` = 用户起的名字；`"script"` = 读时从脚本派生（含 runId 兜底）。 */
  labelSource: "name" | "script";
  status: DynamicWorkflowRunLifecycleStatus;
  /** `status === "stopped"` 才在场。 */
  stopReason?: DynamicWorkflowRunStopReason;
  /** 本 run 修订自哪个 run（`dwf_run.resumed_from`）；不是修订则缺席。 */
  resumedFrom?: string;
  /** 本 run 被哪次修订停下并替代（`stopped(superseded)` 的结算袋）；未被替代则缺席。 */
  supersededBy?: string;
  /** 本会话是否是这个 run 的发起方（journal 的 parent_session_id 命中，或在本会话注册表里）。 */
  ownedByThisSession: boolean;
  /**
   * 「本会话无法证实它还活着」：journal 非终态 ∧ 非本会话 ∧ 不在本会话注册表。可能是死进程
   * 的遗物，也可能是同进程兄弟会话正在飞的 run——所以这是**标注而非状态改写**，读面绝不
   * 替别人收尸（孤儿收敛的执行权只属于 owning 会话的构造时刻）。为真时才在场。
   */
  possiblyInterrupted?: boolean;
  /** journal 的 `time_created` / `time_updated`（epoch ms）。 */
  createdAt: number;
  updatedAt: number;
}

/** 列表的一项：共同截面 + 用量。刻意轻——无 actors、无节点计数、无产物预览。 */
export interface DynamicWorkflowRunListItem extends DynamicWorkflowRunSummary {
  /** 直读 `dwf_run.spent_tokens`（run 级 token 用量的唯一权威）。 */
  spentTokens: number;
}

/**
 * `listRuns` 的返回。刻意是一个对象而不是裸数组：页级字段（如 {@link truncated}）是纯追加
 * 改动，而裸数组只能整体换形状。
 */
export interface DynamicWorkflowRunListResult {
  runs: DynamicWorkflowRunListItem[];
  /**
   * 这个项目还有更多 run 没进这一页。**为真时才在场**。
   *
   * 判据是「多取一条」（实现侧按 `limit + 1` 查询后回落），不是 `length === limit`：后者在
   * 条数正好等于 limit 时误报，而误报会让模型去追一页不存在的历史。同一个惯例在 v4 网关的
   * 事件分页上（`hasMore`）已经用过一次。
   */
  truncated?: boolean;
}

/**
 * run 的进度与用量（观察面，没有任何上限）。`nodesObserved`
 * 是**已落库节点的行数**（三态之和），绝不冒充「总步数」：动态工作流没有静态总数，而
 * `queued` 只存在于事件相位、不落库。
 */
export interface DynamicWorkflowRunUsage {
  spentTokens: number;
  nodesObserved: number;
  nodesRunning: number;
  nodesCompleted: number;
  nodesFailed: number;
}

/** 一个 actor 站点实例。`persona` 刻意不出：整段 system prompt 是端口上天然无界的字段。 */
export interface DynamicWorkflowRunActor {
  siteId: string;
  ordinal: number;
  name?: string;
}

/** 一条 `log()` 叙事。 */
export interface DynamicWorkflowRunLogEntry {
  sequence: number;
  /** 已按端口的字符串上限（{@link DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS}）有界化。 */
  message: string;
  /**
   * 这条事件落 journal 的时刻（`dwf_event.time_created`）。序号定位，时刻回答「多久以前」——
   * 情势截面的三组字段都按这一把尺算年龄，叙事尾巴没有理由用另一把。**没有这一列的老
   * journal 上缺席**，读侧据此不给年龄，绝不用读时的 `Date.now()` 兜底。
   */
  at?: number;
}

/** 单 run 详情：共同截面 + 进度 + 情势截面 + 按终态分叉的产物 / 失败。 */
export interface DynamicWorkflowRunDetail extends DynamicWorkflowRunSummary {
  usage: DynamicWorkflowRunUsage;
  modelBindings?: Record<string, string>;
  /**
   * 本 run 自己的并发上界，语义同 {@link DynamicWorkflowRunSnapshot.maxConcurrency}：只在低于当前
   * 天花板时在场。刻意不进 {@link DynamicWorkflowRunSummary}——列表行不该为一个很少设置的字段加宽。
   */
  maxConcurrency?: number;
  /**
   * 本 run 的子代理模型，语义同 {@link DynamicWorkflowRunSnapshot.subagentModel}：只在设过时
   * 在场。与 `maxConcurrency` 同理不进 {@link DynamicWorkflowRunSummary}——列表行不该为一个
   * 很少设置的字段加宽。
   */
  subagentModel?: string;
  /**
   * 本 run 的脚本文件，语义同 {@link DynamicWorkflowRunSnapshot.scriptPath}：只在确认草稿同步时
   * 在场。`GetWorkflowRun` 据它在 `<amendable>` 里把下一步说成「就地编辑这个文件」。
   */
  scriptPath?: string;
  actors: DynamicWorkflowRunActor[];
  /** `log()` 事件的尾巴，按时序（sequence 升序）。无 log 事件即空数组。 */
  logTail: DynamicWorkflowRunLogEntry[];
  /**
   * 阶段表：声明序的已声明阶段，后面接上「进过但没声明」的那些
   *
   * **脚本没声明阶段、也一个都没进过时整字段缺席**——那样的 run 没有阶段这回事，
   * 发一个空数组读起来像「阶段表是空的」，是另一句话。
   */
  phases?: DynamicWorkflowRunPhaseView[];
  /**
   * 子代理花名册，按 actor 行的顺序（= 铸造顺序）。**恒在场**，一个 actor 都没有的 run 是空
   * 数组：与 `phases` 不同，「这个 run 有几个子代理」永远是个有答案的问题，而 0 就是那个答案。
   *
   * 与并列的 `actors` 刻意不合并：`actors` 是一张恒定的身份表（siteId / ordinal / name），
   * 消费者已经按它 join；这里的每一项都是**读时快照**，同一个 run 隔一秒读就不一样。
   */
  subagents: DynamicWorkflowRunSubagentView[];
  /** run 整体还在不在动（见 {@link DynamicWorkflowRunHealth}）。恒在场。 */
  health: DynamicWorkflowRunHealth;
  /**
   * 脚本的顶层返回值，**原值**（未序列化）。只有 completed 的 run 才在场；`undefined` 产物
   * 即整字段缺席。
   *
   * 为什么不在这里序列化：面向模型的文本投影已经有唯一实现（core 的
   * `serializeWorkflowArtifact`，完成通知与 TaskOutput 共用它）。端口再做一次，就会出现
   * 「同一个 run 的产物在通知里和在本工具里长得不一样」——正是那份共用要排除的损失类别。
   * 所以序列化留在 core，端口只负责把原值送到边界。
   */
  result?: unknown;
  /** errored 恒在场；stopped 只对 provider / interrupted 在场。code 原样透出，不折叠。 */
  error?: DynamicWorkflowRunError;
  /**
   * 此刻停驻在这个 run 上、等主代理作答的升级问题。
   *
   * 与 {@link DynamicWorkflowRunSnapshot.pendingQuestions} **同源同投影**（都读进程内的升级
   * 停驻表，都在零条时整字段缺席），只是换了一条读面：快照服务后台任务追踪器，本字段服务
   * `GetWorkflowRun`——而后者是**模型侧唯一的发现面**。这条链路不是可选的锦上添花：升级通知
   * 有两条已知的丢弃路径（stale branch generation / shutdown），查询是这两条路径的兜底，`resolveQuestion` 的 `unknown_question` 文案也明确让模型来这里找 qid。
   * 缺了它，那两处承诺都会指向一个什么都不返回的工具。
   */
  pendingQuestions?: readonly DynamicWorkflowRunPendingQuestion[];
  /**
   * 本 run 的留白，与 {@link DynamicWorkflowRunSnapshot.holes} **同源同投影**（零条整字段缺席），
   * 只是换了一条读面：本字段服务 `GetWorkflowRun`——留白通知丢失后模型侧唯一的发现面。
   */
  holes?: readonly DynamicWorkflowRunHole[];
  /**
   * 本 run 的用户面产物（任意状态都附；journal-backed，与 {@link DynamicWorkflowRunSnapshot.artifacts}
   * 同源）。`GetWorkflowRun` 据此告诉模型「这些已经以卡片呈现给用户了，按标题引用即可」。
   * 零件时整字段缺席。
   */
  artifacts?: readonly DynamicWorkflowRunArtifact[];
}

/**
 * {@link DynamicWorkflowRunPort.listRunsForSession} 的 run 摘要。字面与 journal 的
 * `dwf_run.status` 同集，但**刻意在这里重新声明**：端口只承载 JSON 形状，引擎词汇表一旦
 * 进 contracts，每个持有端口的层都会编译期依赖引擎内部类型。
 */
export interface DynamicWorkflowRunSessionSummary {
  runId: string;
  /** 发起 run 的 CreateWorkflow 工具调用 id（工具卡 → 详情页/Resume 的关联键）；老 run 缺席。 */
  toolCallId?: string;
  /**
   * 展示标签，服务端读时派生（`name` → 脚本首行 → runId，见 bootstrap 的
   * `resolveDynamicWorkflowRunLabel`）。可选是为了**偏斜安全**：老服务端不发这个键，
   * 读侧回落到 runId 即可——列表少一个标签是退化，不是错误。
   *
   * 与 `resumable` 同理由集中在服务端：两处各拼一次兜底，同一个 run 在
   * `/dwf list` 与工具卡上会显示不同的名字。
   */
  label?: string;
  /**
   * 最后更新时间（epoch 毫秒，来自 journal 的 `dwf_run.time_updated`）。可选同上：
   * 老服务端缺席，读侧不显示时间列。列表排序仍由存储层负责（最近更新在前），
   * 这个字段只供展示——读侧不要拿它重排，否则与服务端的 tie-break 漂移。
   */
  updatedAt?: number;
  status: "completed" | "errored" | "pending" | "running" | "stopped";
  /** `status === "stopped"` 才在场。 */
  stopReason?: DynamicWorkflowRunStopReason;
  /** 本 run 修订自哪个 run；不是修订则缺席。 */
  resumedFrom?: string;
  /** 本 run 被哪次修订停下并替代；未被替代则缺席。 */
  supersededBy?: string;
  /** errored / stopped(provider|interrupted) 的结构化失败编码（`ProviderStop` / `Interrupted` …）。 */
  failureCode?: string;
  failureMessage?: string;
  /**
   * 是否可恢复。**服务端按 resume 门的同一个谓词算好**：UI 若自行按 status+failureCode
   * 重新推导，两处谓词总有一天不一致——按钮亮着但命令被拒。
   */
  resumable: boolean;
}
