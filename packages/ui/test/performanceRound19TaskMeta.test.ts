import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import {
  buildTaskEntityKey,
  buildTaskListCacheDescriptor,
  type CachedTaskListResult,
} from "@/lib/taskQueryCache.js";
import { useTaskQueryCacheStore as store } from "@/store/taskQueryCacheStore.js";
import { attachTaskListRowActivity, getTaskListRowActivity } from "@/v4/taskListRowActivity.js";

type State = ReturnType<typeof store.getState>;
type Update = "upsertTaskMeta" | "updateTaskMetaPreservingMembership";
const ACTIVE = { pinned: false, archived: false };

function mutate(task: ZCodeTaskMeta) {
  store.getState().applyTaskMutation({
    previousTask: task,
    nextTask: task,
    previousState: ACTIVE,
    nextState: ACTIVE,
  });
}

function task(id: string, fields: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId: id,
    traceId: `synthetic-${id}`,
    title: `Task ${id}`,
    workspacePath: "C:/synthetic/workspace",
    createdAt: 1,
    updatedAt: 2,
    mode: "edit",
    changeSummary: undefined,
    model: undefined,
    provider: undefined,
    titleOverridden: undefined,
    status: undefined,
    unreadAt: undefined,
    ...fields,
  };
}

function query(
  items: ZCodeTaskMeta[],
  fields: Partial<CachedTaskListResult> = {},
): CachedTaskListResult {
  return {
    descriptor: buildTaskListCacheDescriptor({
      kind: "workspace",
      sortBy: "updated",
      workspaceScopes: [{ workspacePath: "C:/synthetic/workspace" }],
      expanded: true,
    }),
    taskKeys: items.map(buildTaskEntityKey),
    unreadTaskKeys: [],
    total: items.length,
    hasMore: false,
    fetchedAt: 100,
    stale: false,
    invalidationVersion: 0,
    partial: false,
    loadingShardKeys: [],
    failedShardKeys: [],
    ...fields,
  };
}

function seed(items: ZCodeTaskMeta[], queries = { visible: query(items) }) {
  store.setState({
    taskMetaByEntityKey: Object.fromEntries(items.map((item) => [buildTaskEntityKey(item), item])),
    resultsByQueryKey: queries,
    taskUnreadOverlayByEntityKey: {},
  });
}

function measured<T extends object>(record: T) {
  const metrics = { enumerations: 0, reads: 0 };
  const value = new Proxy(Object.freeze(record), {
    ownKeys(target) {
      metrics.enumerations += 1;
      return Reflect.ownKeys(target);
    },
    get(target, key, receiver) {
      metrics.reads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  return { value, metrics };
}

const cleanups: Array<() => void> = [];
beforeEach(() => store.getState().clearAll());
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  store.getState().clearAll();
  vi.restoreAllMocks();
});

describe("task meta publication work budgets", () => {
  it.each<Update>(["upsertTaskMeta", "updateTaskMetaPreservingMembership"])(
    "%s preserves a large cache on equivalent metadata",
    (update) => {
      // 手动构造已排序缓存，计量范围只包含被测更新，不包含建表或测试自己的枚举。
      const visible = Array.from({ length: 20 }, (_, index) =>
        task(`visible-${index}`, { updatedAt: 100 - index }),
      );
      const cold = Array.from({ length: 10_000 }, (_, index) => task(`cold-${index}`));
      const queries: State["resultsByQueryKey"] = { visible: Object.freeze(query(visible)) };
      for (let index = 0; index < 256; index += 1)
        queries[`cold-query-${index}`] = Object.freeze(query([cold[index]!]));
      seed([...visible, ...cold], queries);
      const entities = measured(store.getState().taskMetaByEntityKey);
      const results = measured(store.getState().resultsByQueryKey);
      store.setState({ taskMetaByEntityKey: entities.value, resultsByQueryKey: results.value });
      const before = store.getState();
      const notified = vi.fn();
      cleanups.push(store.subscribe(notified));
      store.getState()[update]({ ...visible[0]! });
      expect(entities.metrics.enumerations).toBe(0);
      expect(entities.metrics.reads).toBeLessThanOrEqual(update === "upsertTaskMeta" ? 1 : 80);
      expect(results.metrics.enumerations).toBe(update === "upsertTaskMeta" ? 0 : 1);
      expect(store.getState()).toBe(before);
      expect(notified).not.toHaveBeenCalled();
    },
  );

  it.each(["mutation", "preserve"] as const)(
    "does not publish repeated equivalent two-step %s notifications",
    (mode) => {
      const current = task("current");
      seed([current]);
      const before = store.getState();
      const notified = vi.fn();
      cleanups.push(store.subscribe(notified));
      for (let index = 0; index < 40; index += 1) {
        store.getState().upsertTaskMeta({ ...current });
        if (mode === "mutation") mutate({ ...current });
        else store.getState().updateTaskMetaPreservingMembership({ ...current });
      }
      expect(notified.mock.calls.length).toBe(0);
      expect(store.getState()).toBe(before);
    },
  );

  it("updates metadata once while preserving query references when order is unchanged", () => {
    const current = task("current", { titleOverridden: true });
    const other = task("other", { updatedAt: 1 });
    seed([current, other]);
    const before = store.getState();
    Object.freeze(before.taskMetaByEntityKey);
    Object.freeze(before.resultsByQueryKey.visible);
    Object.freeze(before.resultsByQueryKey.visible!.taskKeys);
    const notified = vi.fn();
    cleanups.push(store.subscribe(notified));
    const renamed = Object.freeze({ ...current, title: "Renamed by user", updatedAt: 3 });
    store.getState().updateTaskMetaPreservingMembership(renamed);
    const after = store.getState();
    expect(after.taskMetaByEntityKey[buildTaskEntityKey(current)]!.title).toBe("Renamed by user");
    expect(after.resultsByQueryKey).toBe(before.resultsByQueryKey);
    expect(after.taskUnreadOverlayByEntityKey).toBe(before.taskUnreadOverlayByEntityKey);
    expect(before.taskMetaByEntityKey[buildTaskEntityKey(current)]!.title).toBe(current.title);
    expect(after.taskMetaByEntityKey[buildTaskEntityKey(other)]).toBe(other);
    expect(notified).toHaveBeenCalledTimes(1);
  });

  it.each(["mutation", "preserve"] as const)(
    "%s still sorts after the caller has already upserted the new metadata",
    (mode) => {
      const first = task("first", { updatedAt: 20 });
      const second = task("second", { updatedAt: 10 });
      seed([first, second]);
      const updated = { ...second, updatedAt: 30 };
      store.getState().upsertTaskMeta(updated);
      const intermediate = store.getState();
      expect(intermediate.resultsByQueryKey.visible!.taskKeys).toEqual([
        buildTaskEntityKey(first),
        buildTaskEntityKey(second),
      ]);
      if (mode === "mutation") mutate(updated);
      else store.getState().updateTaskMetaPreservingMembership(updated);
      const after = store.getState();
      expect(after.taskMetaByEntityKey).toBe(intermediate.taskMetaByEntityKey);
      expect(after.resultsByQueryKey.visible!.taskKeys).toEqual([
        buildTaskEntityKey(second),
        buildTaskEntityKey(first),
      ]);
    },
  );

  it("copies the query map once when multiple lists reorder and preserves unrelated lists", () => {
    const first = task("first", { updatedAt: 20 });
    const second = task("second", { updatedAt: 10 });
    const unrelated = task("unrelated");
    seed([first, second, unrelated], {
      visible: query([first, second]),
      another: query([first, second]),
      untouched: query([unrelated]),
    });
    const records = measured(store.getState().resultsByQueryKey);
    store.setState({ resultsByQueryKey: records.value });
    const before = store.getState();
    store.getState().updateTaskMetaPreservingMembership({ ...second, updatedAt: 30 });
    expect(records.metrics.enumerations).toBe(2); // 原遍历一次，首次实际写入时复制一次。
    const after = store.getState();
    expect(after.resultsByQueryKey.visible!.taskKeys).toEqual([
      buildTaskEntityKey(second),
      buildTaskEntityKey(first),
    ]);
    expect(after.resultsByQueryKey.another!.taskKeys).toEqual(
      after.resultsByQueryKey.visible!.taskKeys,
    );
    expect(after.resultsByQueryKey.untouched).toBe(before.resultsByQueryKey.untouched);
    expect(before.resultsByQueryKey.visible!.taskKeys[0]).toBe(buildTaskEntityKey(first));
  });
});

describe("task meta merge and membership boundaries", () => {
  it.each<Update>(["upsertTaskMeta", "updateTaskMetaPreservingMembership"])(
    "%s preserves manual titles, activity and nested metadata on equivalent input",
    (update) => {
      const current = attachTaskListRowActivity(
        task("current", {
          title: "User title",
          titleOverridden: true,
          status: "running",
          updatedAt: 8,
        }),
        {
          phase: "running",
          lastActivityAt: 8,
          hasBackgroundWork: true,
          pendingInteractions: { permissionCount: 1, userInputCount: 0 },
        },
      );
      seed([current]);
      const before = store.getState();
      // 序列化模拟通知重新创建嵌套对象；等价判断不能只比较 sidecar 引用。
      store.getState()[update](JSON.parse(JSON.stringify(current)) as ZCodeTaskMeta);
      expect(store.getState()).toBe(before);
      store.getState()[update](task("current", { title: "New session", updatedAt: 9 }));
      expect(store.getState().taskMetaByEntityKey[buildTaskEntityKey(current)]).toMatchObject({
        title: "User title",
        titleOverridden: true,
        status: "running",
        updatedAt: 8,
      });
      expect(
        getTaskListRowActivity(store.getState().taskMetaByEntityKey[buildTaskEntityKey(current)]!),
      ).toEqual(getTaskListRowActivity(current));
    },
  );

  it("upsert accepts new activity, while preserving membership does not overwrite its owner", () => {
    const current = attachTaskListRowActivity(
      task("current", { updatedAt: 8, status: "running" }),
      { phase: "running", lastActivityAt: 8, hasBackgroundWork: false },
    );
    seed([current]);
    const newer = attachTaskListRowActivity(
      task("current", { updatedAt: 9, status: "completed" }),
      { phase: "completedSuccess", lastActivityAt: 9, hasBackgroundWork: false },
    );
    store.getState().upsertTaskMeta(newer);
    const accepted = store.getState().taskMetaByEntityKey[buildTaskEntityKey(current)]!;
    expect(getTaskListRowActivity(accepted)).toEqual(getTaskListRowActivity(newer));
    store.getState().updateTaskMetaPreservingMembership(current);
    expect(
      getTaskListRowActivity(store.getState().taskMetaByEntityKey[buildTaskEntityKey(current)]!),
    ).toEqual(getTaskListRowActivity(newer));
  });

  it("preserves active/background order, query membership, unread and search metadata", () => {
    const older = attachTaskListRowActivity(task("older", { createdAt: 10, updatedAt: 100 }), {
      phase: "running",
      lastActivityAt: 100,
      hasBackgroundWork: false,
    });
    const newer = attachTaskListRowActivity(task("newer", { createdAt: 20, updatedAt: 30 }), {
      phase: "completedSuccess",
      lastActivityAt: 30,
      hasBackgroundWork: true,
    });
    const key = buildTaskEntityKey(older);
    const result = query([newer, older], {
      total: 30,
      hasMore: true,
      stale: true,
      invalidationVersion: 7,
      unreadTaskKeys: [key],
      searchSnippetsByTaskKey: { [key]: "body-only search match" },
      searchSnippetListsByTaskKey: { [key]: ["body-only search match"] },
      partial: true,
      loadingShardKeys: ["loading"],
      failedShardKeys: ["failed"],
    });
    result.descriptor = {
      ...result.descriptor,
      kind: "pinned",
      search: "body-only",
      visibleLimit: 2,
    };
    seed([older, newer], { visible: result });
    store.setState({ taskUnreadOverlayByEntityKey: { [key]: 123 } });
    const before = store.getState();
    store
      .getState()
      .updateTaskMetaPreservingMembership({ ...older, title: "Renamed", updatedAt: 200 });
    const after = store.getState();
    expect(after.taskMetaByEntityKey[key]!.title).toBe("Renamed");
    expect(after.resultsByQueryKey.visible).toBe(result);
    expect(after.resultsByQueryKey.visible).toEqual(before.resultsByQueryKey.visible);
    expect(after.taskUnreadOverlayByEntityKey).toBe(before.taskUnreadOverlayByEntityKey);
  });

  it("still deduplicates and sorts a stale list even when task metadata is equivalent", () => {
    const current = task("current");
    const missing = task("missing");
    const result = query([missing, current, current]);
    seed([current], { visible: result });
    const before = store.getState();
    store.getState().updateTaskMetaPreservingMembership({ ...current });
    expect(store.getState().taskMetaByEntityKey).toBe(before.taskMetaByEntityKey);
    expect(store.getState().resultsByQueryKey.visible!.taskKeys).toEqual([
      buildTaskEntityKey(current),
      buildTaskEntityKey(missing),
    ]);
    expect(result.taskKeys).toHaveLength(3);
    expect(store.getState().resultsByQueryKey.visible!.total).toBe(3);
  });

  it.each<Update>(["upsertTaskMeta", "updateTaskMetaPreservingMembership"])(
    "%s stores a new identity without merging an existing same-path task or inserting membership",
    (update) => {
      const existing = task("shared", { workspaceIdentity: "remote-identity-a" });
      const incoming = task("shared", {
        workspaceIdentity: "remote-identity-b",
        title: "Separate task",
      });
      seed([existing]);
      const before = store.getState();
      store.getState()[update](Object.freeze(incoming));
      const after = store.getState();
      expect(after.taskMetaByEntityKey[buildTaskEntityKey(incoming)]).toEqual(incoming);
      expect(after.taskMetaByEntityKey[buildTaskEntityKey(existing)]).toBe(existing);
      expect(after.resultsByQueryKey).toBe(before.resultsByQueryKey);
    },
  );
});
