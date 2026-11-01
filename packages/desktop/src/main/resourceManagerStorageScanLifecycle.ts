import type { StorageManagementApi } from "@zcode/shared";

type StorageScanCommands = Pick<StorageManagementApi, "startScan" | "cancelScan">;

/** Main 独占启动回应与关闭用 jobId；实际任务仍由 StorageService 持有。 */
export function createResourceManagerStorageScanLifecycle<Subscriber>(options: {
  getService(): StorageScanCommands;
  isSubscriberActive(subscriber: Subscriber): boolean;
}) {
  let latestJobId: string | null = null;
  let startGeneration = 0;
  return {
    async startScan(subscriber: Subscriber) {
      const generation = ++startGeneration;
      const service = options.getService();
      const result = await service.startScan();
      // 窗口关闭或新请求会先作废回应；迟到 id 必须取消，不能覆盖新窗口的关闭目标。
      if (generation !== startGeneration || !options.isSubscriberActive(subscriber)) {
        await service.cancelScan(result.jobId);
        return result;
      }
      latestJobId = result.jobId;
      return result;
    },
    async cancelScan(jobId: string): Promise<void> {
      await options.getService().cancelScan(jobId);
      if (latestJobId === jobId) latestJobId = null;
    },
    async close(): Promise<void> {
      // 根目录解析时还没有 jobId，先作废回应；清空已知 id 也必须发生在取消 await 前。
      ++startGeneration;
      const jobId = latestJobId;
      latestJobId = null;
      if (jobId) await options.getService().cancelScan(jobId);
    },
  };
}
