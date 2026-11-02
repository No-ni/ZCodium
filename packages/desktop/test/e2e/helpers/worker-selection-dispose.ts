/** 单一 fixture owner 逐项释放资源；失败不能跳过后续收尾和全局目录恢复。 */
export async function disposeWorkerSelectionResources(resources: {
  syncer?: { disposeAll(): void };
  agent?: { disposeAllAndWait(): Promise<void> };
  repo?: { close(): void };
  runtime?: { dispose(): void };
  replay: { stop(): Promise<void> };
  restoreDataDir(): void;
}): Promise<void> {
  const errors: unknown[] = [];
  const steps = [
    () => resources.syncer?.disposeAll(),
    () => resources.agent?.disposeAllAndWait(),
    () => resources.repo?.close(),
    () => resources.runtime?.dispose(),
    () => resources.replay.stop(),
  ];
  try {
    for (const step of steps) {
      try {
        await step();
      } catch (error) {
        errors.push(error);
      }
    }
  } finally {
    resources.restoreDataDir();
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Worker fixture disposal failed");
}
