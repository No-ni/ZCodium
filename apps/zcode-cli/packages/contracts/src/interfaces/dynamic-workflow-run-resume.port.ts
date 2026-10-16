// 从主 run 端口拆出恢复结果，保持公开再导出与 max-lines 边界。

/** {@link DynamicWorkflowRunPort.resume} 的结构化失败原因。 */
export type DynamicWorkflowRunResumeErrorReason =
  /** journal 里没有这个 run。 */
  | "not_found"
  /** run 不在可恢复集里（completed 或 errored；只有 stopped 可恢复）。 */
  | "not_resumable"
  /** run 被一次 AmendWorkflow 停下并替代：活的是后继，重放它等于把同一件事做两遍。 */
  | "superseded"
  /** 同 runId 的 run 正在本进程内飞行。 */
  | "already_running"
  /** 记录缺 scriptText（落库该字段之前的老 run），没有可重跑的脚本。 */
  | "script_missing"
  /** 记录的 scriptHash 与按 scriptText 重算的不一致（记录自身被外力改写过）。 */
  | "script_mismatch"
  /**
   * 记录的 scriptText 在**当前** facade 下不再通过类型检查（facade 重构后的老 run）。逐字重放
   * 只会失败；出路是按当前 facade 改写脚本后走 AmendWorkflow。`message` 携带有界诊断。
   */
  | "compile_failed";

/**
 * resume 的结构化结果。失败走 reason 而不是 throw：五种原因全是调用方可预期的业务分支
 * （错误码而非错误文本做流程判断，house rule），throw 只留给真正的接线故障。
 */
export type DynamicWorkflowRunResumeResult =
  | { ok: true; runId: string; toolCallId?: string }
  | { ok: false; reason: DynamicWorkflowRunResumeErrorReason; message?: string };
