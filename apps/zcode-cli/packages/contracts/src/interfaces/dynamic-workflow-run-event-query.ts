export interface DynamicWorkflowRunWaitOptions {
  signal?: AbortSignal;
}

/**
 * 事件日志的分页参数；cursor = journal sequence（appendEvent 单调分配）。
 *
 * 两道界同时生效（docs/execution-engine.md「Reading the journal」）：页在条数到 `limit`、或
 * 再加一条就会让存储里的序列化字节超过 `maxBytes` 时收尾；第一条总是带上，所以一条超过
 * `maxBytes` 的事件自成一页。实现方缺省两者时各取一个有界的默认值——事件日志一页永远有界。
 */
export interface DynamicWorkflowRunEventPage {
  /** 只取 sequence 严格大于该值的事件；缺省从头取。 */
  afterSequence?: number;
  limit?: number;
  maxBytes?: number;
}

/** 事件日志的一页。`hasMore` 由存储层判定：页之后是否还有事件。 */
export interface DynamicWorkflowRunEventsResult {
  events: DynamicWorkflowRunEvent[];
  hasMore: boolean;
}

/**
 * 一条 run 事件的**协议形态**：sequence + 事件种类 + JSON 载荷。
 *
 * 刻意不复用引擎的 `RunEvent`：那是领域包（@zcode/dynamic-workflow）的词汇表，把它
 * import 进 contracts 会让每一个持有端口的层都编译期依赖引擎内部类型。端口只承载
 * JSON 形状，`type` 是不透明字符串，`payload` 由读端按需解释。
 */
export interface DynamicWorkflowRunEvent {
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  /** 载荷经 {@link boundDynamicWorkflowRunEventPayload} 裁剪过（原始事实仍在 journal）。 */
  truncated?: boolean;
}
