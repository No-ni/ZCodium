import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { useTaskQueryCacheStore as store } from "@/store/taskQueryCacheStore.js";
import {
  buildTaskEntityKey,
  buildTaskListCacheDescriptor,
  buildTaskListCacheKeyFromDescriptor,
} from "@/lib/taskQueryCache.js";
import { attachTaskListRowActivity, getTaskListRowActivity } from "@/v4/taskListRowActivity.js";

type State = ReturnType<typeof store.getState>;
type Entry = Parameters<State["setQueryResults"]>[0][number];

function task(id: string, fields: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId: id,
    traceId: `synthetic-${id}`,
    title: `Task ${id}`,
    workspacePath: "C:/synthetic/workspace",
    createdAt: 1,
    updatedAt: 2,
    mode: "edit",
    ...fields,
  };
}

function entry(
  items: ZCodeTaskMeta[],
  options: { search?: string; identity?: string; limit?: number } = {},
): Entry {
  const descriptor = buildTaskListCacheDescriptor({
    kind: "workspace",
    sortBy: "updated",
    workspaceScopes: [
      { workspacePath: "C:/synthetic/workspace", workspaceIdentity: options.identity },
    ],
    search: options.search,
    expanded: false,
    visibleLimit: options.limit ?? 20,
  });
  return {
    queryKey: buildTaskListCacheKeyFromDescriptor(descriptor),
    descriptor,
    items,
    total: items.length,
    hasMore: false,
  };
}

function measure<T extends Record<string, unknown>>(record: T) {
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

function measuredState() {
  const current = store.getState();
  const tasks = measure(current.taskMetaByEntityKey);
  const overlays = measure(current.taskUnreadOverlayByEntityKey);
  const queries = measure(current.resultsByQueryKey);
  store.setState({
    taskMetaByEntityKey: tasks.value,
    taskUnreadOverlayByEntityKey: overlays.value,
    resultsByQueryKey: queries.value,
  });
  const oldState = store.getState();
  const notifications = vi.fn();
  const unsubscribe = store.subscribe(notifications);
  cleanups.push(unsubscribe);
  return { tasks, overlays, queries, oldState, notifications };
}

function warmLargeCache() {
  const visible = Array.from({ length: 20 }, (_, index) => task(`visible-${index}`));
  const input = entry(visible);
  store.getState().setQueryResults([input]);
  const state = store.getState();
  const taskMetaByEntityKey = { ...state.taskMetaByEntityKey };
  const taskUnreadOverlayByEntityKey: State["taskUnreadOverlayByEntityKey"] = {};
  const resultsByQueryKey = { ...state.resultsByQueryKey };
  for (let index = 0; index < 10_000; index += 1) {
    const cold = task(`cold-${index}`);
    taskMetaByEntityKey[buildTaskEntityKey(cold)] = Object.freeze(cold);
  }
  for (let index = 0; index < 256; index += 1) {
    resultsByQueryKey[`synthetic-cold-query-${index}`] = state.resultsByQueryKey[input.queryKey];
    taskUnreadOverlayByEntityKey[buildTaskEntityKey(task(`cold-${index}`))] = 1;
  }
  store.setState({ taskMetaByEntityKey, taskUnreadOverlayByEntityKey, resultsByQueryKey });
  return input;
}

const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(1000);
  store.getState().clearAll();
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  store.getState().clearAll();
  vi.restoreAllMocks();
});

describe("task query cache copy budgets", () => {
  it("an empty batch preserves all state and does no record work", () => {
    warmLargeCache();
    const measured = measuredState();
    store.getState().setQueryResults([]);
    expect([measured.tasks.metrics, measured.overlays.metrics, measured.queries.metrics]).toEqual([
      { enumerations: 0, reads: 0 },
      { enumerations: 0, reads: 0 },
      { enumerations: 0, reads: 0 },
    ]);
    expect(store.getState()).toBe(measured.oldState);
    expect(measured.notifications).not.toHaveBeenCalled();
  });

  it.each(["batch", "single"] as const)(
    "%s unread acknowledgement copies the overlay without copying equivalent entities",
    (mode) => {
      const original = task("acknowledged", { unreadAt: 5 });
      const input = entry([original]);
      store.getState().setQueryResults([input]);
      const key = buildTaskEntityKey(original);
      store.setState({ taskUnreadOverlayByEntityKey: { [key]: 5 } });
      const measured = measuredState();
      if (mode === "batch") store.getState().setQueryResults([input]);
      else store.getState().setQueryResult(input);
      expect([
        measured.tasks.metrics.enumerations,
        measured.overlays.metrics.enumerations,
        measured.queries.metrics.enumerations,
      ]).toEqual([0, 1, mode === "batch" ? 0 : 1]);
      expect(store.getState().taskMetaByEntityKey).toBe(measured.tasks.value);
      expect(store.getState().taskUnreadOverlayByEntityKey).toEqual({});
      expect(measured.oldState.taskUnreadOverlayByEntityKey[key]).toBe(5);
      expect(measured.notifications).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["batch", "single"] as const)(
    "%s equal republishing never scans the historical records",
    (mode) => {
      const input = warmLargeCache();
      const measured = measuredState();
      for (let iteration = 0; iteration < 40; iteration += 1) {
        const freshInput = { ...input, items: input.items.map((item) => ({ ...item })) };
        if (mode === "batch") store.getState().setQueryResults([freshInput]);
        else store.getState().setQueryResult(freshInput);
      }
      expect(measured.tasks.metrics.reads).toBeLessThanOrEqual(40 * 20);
      expect([
        measured.tasks.metrics.enumerations,
        measured.overlays.metrics.enumerations,
        measured.queries.metrics.enumerations,
      ]).toEqual([0, 0, 0]);
      expect(store.getState()).toBe(measured.oldState);
      expect(measured.notifications).not.toHaveBeenCalled();
    },
  );

  it("rejects a stale batch before reading items or cloning any record", () => {
    const input = warmLargeCache();
    store.getState().markWorkspaceKeysStale(input.descriptor.workspaceKeys);
    const measured = measuredState();
    const stale = {
      ...input,
      expectedInvalidationVersion: 0,
      get items(): Entry["items"] {
        throw new Error("stale items must not be read");
      },
    };
    store.getState().setQueryResults([stale]);
    expect([
      measured.tasks.metrics.enumerations,
      measured.overlays.metrics.enumerations,
      measured.queries.metrics.enumerations,
    ]).toEqual([0, 0, 0]);
    expect(store.getState()).toBe(measured.oldState);
    expect(measured.notifications).not.toHaveBeenCalled();
  });

  it.each(["batch", "single"] as const)(
    "%s query-only changes preserve task and unread records",
    (mode) => {
      const input = warmLargeCache();
      const measured = measuredState();
      const changed = {
        ...input,
        total: 100,
        hasMore: true,
        partial: true,
        loadingShardKeys: ["loading"],
        failedShardKeys: ["failed"],
      };
      if (mode === "batch") store.getState().setQueryResults([changed]);
      else store.getState().setQueryResult(changed);
      expect([
        measured.tasks.metrics.enumerations,
        measured.overlays.metrics.enumerations,
        measured.queries.metrics.enumerations,
      ]).toEqual([0, 0, 1]);
      const current = store.getState();
      expect(current.taskMetaByEntityKey).toBe(measured.tasks.value);
      expect(current.taskUnreadOverlayByEntityKey).toBe(measured.overlays.value);
      expect(current.resultsByQueryKey[input.queryKey]).toMatchObject({
        total: 100,
        hasMore: true,
        partial: true,
        loadingShardKeys: ["loading"],
        failedShardKeys: ["failed"],
      });
      expect(measured.oldState.resultsByQueryKey[input.queryKey].total).toBe(20);
      expect(measured.notifications).toHaveBeenCalledTimes(1);
    },
  );

  it("copies only the entity record once for many changed items in one batch", () => {
    const input = warmLargeCache();
    const measured = measuredState();
    const items = input.items.map((item) =>
      Object.freeze({ ...item, title: `${item.title} changed` }),
    );
    store.getState().setQueryResults([{ ...input, items }]);
    expect([
      measured.tasks.metrics.enumerations,
      measured.overlays.metrics.enumerations,
      measured.queries.metrics.enumerations,
    ]).toEqual([1, 0, 0]);
    const current = store.getState();
    for (const item of items) {
      expect(current.taskMetaByEntityKey[buildTaskEntityKey(item)].title).toBe(item.title);
      expect(measured.oldState.taskMetaByEntityKey[buildTaskEntityKey(item)].title).not.toBe(
        item.title,
      );
    }
    expect(current.resultsByQueryKey).toBe(measured.queries.value);
    expect(current.taskMetaByEntityKey[buildTaskEntityKey(task("cold-1"))]).toBe(
      measured.oldState.taskMetaByEntityKey[buildTaskEntityKey(task("cold-1"))],
    );
    expect(measured.notifications).toHaveBeenCalledTimes(1);
  });

  it("copies all changed records at most once and publishes an entire multi-workspace batch", () => {
    const first = task("same", { workspaceIdentity: "remote-a", unreadAt: 5 });
    const second = task("same", { workspaceIdentity: "remote-b", unreadAt: 6 });
    const a = entry([first], { identity: "remote-a" });
    const b = entry([second], { identity: "remote-b" });
    store.getState().setQueryResults([a, b]);
    store.setState({
      taskUnreadOverlayByEntityKey: {
        [buildTaskEntityKey(first)]: 5,
        [buildTaskEntityKey(second)]: 6,
      },
    });
    const measured = measuredState();
    store.getState().setQueryResults([
      { ...a, items: [{ ...first, title: "A renamed" }], total: 8, hasMore: true },
      { ...b, items: [{ ...second, title: "B renamed" }], total: 9, hasMore: true },
    ]);
    expect([
      measured.tasks.metrics.enumerations,
      measured.overlays.metrics.enumerations,
      measured.queries.metrics.enumerations,
    ]).toEqual([1, 1, 1]);
    const current = store.getState();
    expect(current.taskUnreadOverlayByEntityKey).toEqual({});
    expect(current.taskMetaByEntityKey[buildTaskEntityKey(first)].title).toBe("A renamed");
    expect(current.taskMetaByEntityKey[buildTaskEntityKey(second)].title).toBe("B renamed");
    expect(current.resultsByQueryKey[a.queryKey].total).toBe(8);
    expect(current.resultsByQueryKey[b.queryKey].total).toBe(9);
    expect(measured.oldState.taskUnreadOverlayByEntityKey[buildTaskEntityKey(first)]).toBe(5);
    expect(measured.notifications).toHaveBeenCalledTimes(1);
  });
});

describe("task query cache semantic boundaries", () => {
  it("retains the initial unread overlay throughout the batch, even after an earlier acknowledgement", () => {
    const original = task("unread", { unreadAt: 9 });
    const input = entry([original]);
    store.getState().setQueryResults([input]);
    store.getState().setTaskUnreadOverlay(original, undefined);
    const before = store.getState();
    Object.freeze(before.taskMetaByEntityKey);
    Object.freeze(before.taskUnreadOverlayByEntityKey);
    store.getState().setQueryResults([
      { ...input, items: [{ ...original, unreadAt: undefined }] },
      { ...input, items: [{ ...original, title: "Later metadata", unreadAt: 9 }] },
    ]);
    const current = store.getState();
    expect(current.taskMetaByEntityKey[buildTaskEntityKey(original)]).toMatchObject({
      title: "Later metadata",
      unreadAt: undefined,
    });
    expect(current.taskUnreadOverlayByEntityKey).toEqual({});
    expect(before.taskUnreadOverlayByEntityKey[buildTaskEntityKey(original)]).toBeNull();
  });

  it("preserves an unacknowledged overlay and rejects stale metadata before acknowledging it", () => {
    const original = task("unread", { unreadAt: 1 });
    const input = entry([original]);
    store.getState().setQueryResults([input]);
    store.getState().setTaskUnreadOverlay(original, 9);
    store.getState().markWorkspaceKeysStale(input.descriptor.workspaceKeys);
    const version = store.getState().resultsByQueryKey[input.queryKey].invalidationVersion;
    const measured = measuredState();
    store.getState().setQueryResults([
      {
        ...input,
        items: [{ ...original, unreadAt: 9, title: "Stale" }],
        expectedInvalidationVersion: version - 1,
      },
      { ...input, expectedInvalidationVersion: version },
    ]);
    expect(measured.overlays.metrics.enumerations).toBe(0);
    const current = store.getState();
    expect(current.taskMetaByEntityKey[buildTaskEntityKey(original)].unreadAt).toBe(9);
    expect(current.taskMetaByEntityKey[buildTaskEntityKey(original)].title).toBe(original.title);
    expect(current.taskUnreadOverlayByEntityKey[buildTaskEntityKey(original)]).toBe(9);
    expect(current.resultsByQueryKey[input.queryKey]).toMatchObject({
      stale: false,
      invalidationVersion: version,
    });
  });

  it("merges duplicate entities in input order while preserving activity, titles and search snippets", () => {
    const original = attachTaskListRowActivity(
      task("shared", { title: "Meaningful title", status: "running" }),
      {
        phase: "running",
        lastActivityAt: 2,
        hasBackgroundWork: false,
      },
    );
    store.getState().setQueryResults([entry([original])]);
    const placeholder = attachTaskListRowActivity(
      task("shared", { title: "New session", status: "running" }),
      getTaskListRowActivity(original)!,
    );
    const searchItem = {
      ...task("shared", { title: "Search title" }),
      searchSnippet: "body match",
      searchSnippets: ["body match", "another match"],
    };
    const search = entry([searchItem], { search: "body" });
    store.getState().setQueryResults([entry([placeholder]), search]);
    const current = store.getState();
    const merged = current.taskMetaByEntityKey[buildTaskEntityKey(original)];
    expect(merged.title).toBe("Search title");
    expect(getTaskListRowActivity(merged)).toEqual(getTaskListRowActivity(original));
    expect(
      current.resultsByQueryKey[search.queryKey].searchSnippetListsByTaskKey?.[
        buildTaskEntityKey(original)
      ],
    ).toEqual(["body match", "another match"]);
    store.getState().setQueryResults([entry([placeholder])]);
    expect(store.getState().taskMetaByEntityKey[buildTaskEntityKey(original)]).toMatchObject({
      title: "Search title",
      searchSnippet: "body match",
    });
  });

  it("preserves fresh local tasks, original page order, total and more flag", () => {
    const older = task("older");
    const local = task("local", { updatedAt: 2000 });
    const input = entry([local, older], { limit: 2 });
    store.getState().setQueryResults([input]);
    const before = store.getState();
    Object.freeze(before.taskMetaByEntityKey);
    store.getState().setQueryResults([{ ...input, items: [older], total: 1 }]);
    const current = store.getState().resultsByQueryKey[input.queryKey];
    expect(current.taskKeys).toEqual([buildTaskEntityKey(local), buildTaskEntityKey(older)]);
    expect(current.total).toBe(2);
    expect(current.hasMore).toBe(false);
    expect(store.getState().taskMetaByEntityKey).toBe(before.taskMetaByEntityKey);
  });
});
