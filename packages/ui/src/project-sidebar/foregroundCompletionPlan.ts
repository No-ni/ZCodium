/** 前台完成补记记录：written=已补写，marker=补写回包的未读版本（自动清除的 CAS 凭据）。 */
export interface ForegroundCompletionRecord<Address> {
  target: Address;
  written: boolean;
  marker?: number;
}

export interface ForegroundCompletionFlushPlan<Address> {
  /** 离开窗口这一刻仍在面前、需要补写未读的记录。 */
  flush: Array<[string, ForegroundCompletionRecord<Address>]>;
  /** 用户已经导航离开该任务、补写资格已作废的记录 key。 */
  drop: string[];
}

/**
 * 计算窗口失焦/最小化/页面隐藏时，未补写的前台完成记录该补写还是作废。
 *
 * Bug 根因：旧实现只按 written 过滤后无条件补写，不校验「离开这一刻用户还在不在这个
 * 任务上」。用户在任务完成时正看着它，随后在应用内新开会话（窗口从未失焦），记录就留在
 * Map 里；下一次失焦/回到窗口触发补写时，早已离开的任务也被写成未读。而自动清除只对
 * 「回到窗口时仍在面前」的任务生效，于是蓝点只能等用户回去点一下才消失。
 * 补写的语义是「刚在眼前完成、用户没处理就离开」，所以只有离开瞬间仍在面前的任务才需要
 * 补写；已经导航离开说明结果早被看到，记录直接丢弃、不再产生提醒。
 * spec: docs/ui/task-unread-state.md 被动标记未读「前台完成的离开补记」。
 */
export function planForegroundCompletionFlush<Address>(
  records: Iterable<[string, ForegroundCompletionRecord<Address>]>,
  isStillViewing: (target: Address) => boolean,
): ForegroundCompletionFlushPlan<Address> {
  const plan: ForegroundCompletionFlushPlan<Address> = { flush: [], drop: [] };
  for (const [key, record] of records) {
    if (record.written) continue;
    if (isStillViewing(record.target)) plan.flush.push([key, record]);
    else plan.drop.push(key);
  }
  return plan;
}
