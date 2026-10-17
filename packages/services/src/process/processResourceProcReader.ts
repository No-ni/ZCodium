const LINUX_PROC_READ_WORKERS = 8;

/** 单次 /proc 表读取的 I/O 调度；映射由调用方提供，结果保留目录条目顺序。 */
export async function readLinuxProcEntries<Row>(
  entries: readonly string[],
  readText: (path: string) => Promise<string>,
  mapRow: (stat: string, status: string) => Row | undefined,
  signal?: AbortSignal,
): Promise<Row[]> {
  const processEntries = entries.filter((entry) => /^\d+$/.test(entry));
  const rows = Array.from({ length: processEntries.length }, (): Row | undefined => undefined);
  let nextIndex = 0;
  // 大进程表原先会一次排队 2P 次 /proc 读取；本轮最多 8 个 worker，
  // 每个 worker 等 stat/status 都结束后才领取下一项，失败也不能提前释放 I/O 槽位。
  await Promise.all(
    Array.from({ length: Math.min(LINUX_PROC_READ_WORKERS, processEntries.length) }, async () => {
      while (nextIndex < processEntries.length && !signal?.aborted) {
        const index = nextIndex++;
        const entry = processEntries[index];
        try {
          const [stat, status] = await Promise.allSettled([
            Promise.resolve().then(() => readText(`/proc/${entry}/stat`)),
            Promise.resolve().then(() => readText(`/proc/${entry}/status`)),
          ]);
          if (stat.status !== "fulfilled" || status.status !== "fulfilled") continue;
          rows[index] = mapRow(stat.value, status.value);
        } catch {
          // 进程在读取期间退出属正常现象，跳过即可。
        }
      }
    }),
  );
  return rows.filter((row): row is Row => row !== undefined);
}
