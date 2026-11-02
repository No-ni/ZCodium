// Dynamic Workflow Run Port：调整运行中的并发上限。
// 定义请求、结果与能力边界，由 dynamic-workflow-run.port.ts 统一再导出，
// 调用方通过 `@zcode/contracts` 使用。

/**
 * {@link import("./dynamic-workflow-run.port.js").DynamicWorkflowRunPort.retuneConcurrency}
 * 的请求。
 */
export interface DynamicWorkflowRunRetuneRequest {
  runId: string;
  /**
   * 新的并发上界。`null` = 默认并发（与 `AmendWorkflow` 的 `max_concurrency: null` 同义）。
   * 与当前提交路径共用归一化：向下取整、至少 1、没有 CPU 派生上限。
   */
  maxConcurrency: number | null;
}

/**
 * retune 被拒的结构化理由。两者对调用方是**两个不同的下一步**，所以必须可分辨：
 *
 *   - `not_live`：本 service 手上没有这个在飞 run（从来不是本进程的、已经结算的），或者它恰好
 *     在存活判定与本次调用之间结算了。调用方回落到一次真正的修订（`AmendWorkflow` 的既有那条路）。
 *   - `unchanged`：值与此刻生效的上界相同。什么都没写、什么都没停——`current` 就是那个值，
 *     调用方据它写出「已经是 n 了」。
 */
export type DynamicWorkflowRunRetuneRefusalReason = "not_live" | "unchanged";

/**
 * retune 的结构化结果。失败走 reason 而不是 throw，与
 * {@link import("./dynamic-workflow-run.port.js").DynamicWorkflowRunAmendResult} 同一条论证：
 * 两种理由都是调用方可预期的业务分支。
 *
 * `defaultConcurrency` 与 `previous` 由运行端口提供：回话在新值等于默认时注明「默认」，
 * 事件日志使用前后数值。合并旧 ceiling 字段会与现行归一化和调用方合同不一致。
 */
export type DynamicWorkflowRunRetuneResult =
  | { ok: true; maxConcurrency: number; previous: number; defaultConcurrency: number }
  | {
      ok: false;
      reason: DynamicWorkflowRunRetuneRefusalReason;
      /** 此刻生效的上界；`unchanged` 恒在场，`not_live` 只在还读得到时在场。 */
      current?: number;
    };
