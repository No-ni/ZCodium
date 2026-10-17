import { describe, expect, it, vi } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { fetchTaskListMembershipSetsForEndpointsCached as fetchCached } from "@/lib/taskListMembershipSets.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const service = {
    listTasks: vi.fn(async (): Promise<ZCodeTaskMeta[]> => []),
    listArchivedTasks: vi.fn(async (): Promise<ZCodeTaskMeta[]> => []),
    listPinnedTasks: vi.fn(async (): Promise<ZCodeTaskMeta[]> => []),
    listPinnedTaskIds: vi.fn(async (): Promise<string[]> => []),
    listDeletedTaskIds: vi.fn(async (): Promise<string[]> => []),
  };
  const read = (cacheKey = "primary") =>
    fetchCached({
      cacheKey,
      endpoints: [{ service, scopes: [{ workspacePath: "C:/synthetic/workspace" }] }],
    });
  const evictPrimary = async () => {
    for (let index = 0; index < 8; index += 1) await read(`filler-${index}`);
  };
  return { service, read, evictPrimary };
}

describe("membership promise cleanup ownership", () => {
  it.each(["pending", "resolved"] as const)(
    "a late evicted failure cannot delete the %s replacement",
    async (phase) => {
      const { service, read, evictPrimary } = fixture();
      const old = deferred<ZCodeTaskMeta[]>();
      service.listTasks.mockReturnValueOnce(old.promise);
      const oldOutcome = read().catch((error: unknown) => error);
      await evictPrimary();
      const next = deferred<ZCodeTaskMeta[]>();
      service.listTasks.mockReturnValueOnce(next.promise);
      const replacement = read();
      if (phase === "resolved") {
        next.resolve([]);
        await replacement;
      }
      old.reject(new Error("synthetic old failure"));
      expect(await oldOutcome).toEqual(new Error("tasks-index task 行读取不完整"));
      try {
        const calls = service.listTasks.mock.calls.length;
        const shared = read();
        for (const method of Object.values(service)) expect(method).toHaveBeenCalledTimes(calls);
        expect(shared).toBe(replacement);
      } finally {
        next.resolve([]);
        await replacement;
      }
    },
  );

  it("the current failed promise is removed, permitting one new shared retry", async () => {
    const { service, read } = fixture();
    service.listTasks.mockRejectedValueOnce(new Error("synthetic transient failure"));
    const failed = read();
    expect(read()).toBe(failed);
    await expect(failed).rejects.toThrow("读取不完整");
    const retry = read();
    expect(read()).toBe(retry);
    expect(service.listTasks).toHaveBeenCalledTimes(2);
    await retry;
  });

  it("a replacement can fail after the evicted request, and still permits a later retry", async () => {
    const { service, read, evictPrimary } = fixture();
    const old = deferred<ZCodeTaskMeta[]>();
    service.listTasks.mockReturnValueOnce(old.promise);
    const oldOutcome = read().catch((error: unknown) => error);
    await evictPrimary();
    const next = deferred<ZCodeTaskMeta[]>();
    service.listTasks.mockReturnValueOnce(next.promise);
    const replacement = read();
    const nextOutcome = replacement.catch((error: unknown) => error);
    old.reject(new Error("old failure"));
    await oldOutcome;
    next.reject(new Error("current failure"));
    await nextOutcome;
    const retry = read();
    expect(read()).toBe(retry);
    expect(service.listTasks).toHaveBeenCalledTimes(11);
    await retry;
  });

  it("keeps the eight-key capacity, successful request reuse and service identity boundary", async () => {
    const a = fixture();
    const b = fixture();
    const first = a.read();
    await first;
    expect(a.read()).toBe(first);
    const other = b.read();
    expect(other).not.toBe(first);
    await other;
    await a.evictPrimary();
    const replacement = a.read();
    expect(replacement).not.toBe(first);
    await replacement;
    expect(a.service.listTasks).toHaveBeenCalledTimes(10);
    expect(b.service.listTasks).toHaveBeenCalledTimes(1);
  });

  it("evicts the oldest key at eight entries without refreshing its order on a cache hit", async () => {
    const { service, read } = fixture();
    const first = read();
    await first;
    for (let index = 0; index < 7; index += 1) await read(`exact-capacity-${index}`);
    expect(read()).toBe(first);
    expect(service.listTasks).toHaveBeenCalledTimes(8);
    await read("ninth-key");
    const replacement = read();
    expect(replacement).not.toBe(first);
    expect(service.listTasks).toHaveBeenCalledTimes(10);
    await replacement;
  });
});
