type TestOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** 断言和恢复同时失败时保留两份错误，不让清理失败掩盖首次故障。 */
export async function withNativeContextCleanup<T>(
  action: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> {
  let outcome: TestOutcome<T>;
  try {
    outcome = { ok: true, value: await action() };
  } catch (error) {
    outcome = { ok: false, error };
  }
  try {
    await cleanup();
  } catch (error) {
    if (!outcome.ok)
      throw new AggregateError([outcome.error, error], "NCTX assertion and cleanup both failed");
    throw error;
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/** 每个独立收尾动作都执行；失败只在全部收尾完成后报告。 */
export async function runNativeContextCleanup(...steps: Array<() => Promise<void>>): Promise<void> {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "NCTX teardown failed");
}
