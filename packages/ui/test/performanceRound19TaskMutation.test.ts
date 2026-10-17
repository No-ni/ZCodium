import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import {
  buildTaskEntityKey,
  buildTaskListCacheDescriptor,
  type CachedTaskListResult,
  type TaskListQueryKind,
} from "@/lib/taskQueryCache.js";
import {
  applyTaskQueryCacheMutation,
  useTaskQueryCacheStore as store,
} from "@/store/taskQueryCacheStore.js";

const ACTIVE = { pinned: false, archived: false };
const PINNED = { pinned: true, archived: false };
const ARCHIVED = { pinned: false, archived: true };
type State = ReturnType<typeof store.getState>;

function task(id: string, fields: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId: id,
    traceId: `synthetic-${id}`,
    title: `Task ${id}`,
    workspacePath: "C:/synthetic/workspace",
    mode: "edit",
    createdAt: 1,
    updatedAt: 2,
    ...fields,
  };
}

function query(
  kind: TaskListQueryKind,
  items: ZCodeTaskMeta[],
  fields: Partial<CachedTaskListResult> = {},
): CachedTaskListResult {
  return {
    descriptor: buildTaskListCacheDescriptor({
      kind,
      sortBy: "updated",
      expanded: true,
      workspaceScopes: [{ workspacePath: "C:/synthetic/workspace" }],
    }),
    taskKeys: items.map(buildTaskEntityKey),
    total: items.length,
    hasMore: false,
    stale: false,
    invalidationVersion: 0,
    fetchedAt: 100,
    partial: false,
    loadingShardKeys: [],
    failedShardKeys: [],
    ...fields,
  };
}

function seed(items: ZCodeTaskMeta[], resultsByQueryKey: State["resultsByQueryKey"]) {
  store.setState({
    resultsByQueryKey,
    taskMetaByEntityKey: Object.fromEntries(
      items.map((item) => [buildTaskEntityKey(item), Object.freeze(item)]),
    ),
    taskUnreadOverlayByEntityKey: {},
  });
}

const cleanups: Array<() => void> = [];
beforeEach(() => store.getState().clearAll());
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  store.getState().clearAll();
  vi.restoreAllMocks();
});

describe("task mutation work and semantic boundaries", () => {
  it("does not copy a large entity table when a same-membership update is already represented", () => {
    const current = task("current", { updatedAt: 20 });
    const cold = Array.from({ length: 10_000 }, (_, index) => task(`cold-${index}`));
    seed([current, ...cold], { visible: query("timeline", [current]) });
    let reads = 0;
    let enumerations = 0;
    const entities = new Proxy(Object.freeze(store.getState().taskMetaByEntityKey), {
      ownKeys(target) {
        enumerations += 1;
        return Reflect.ownKeys(target);
      },
      get(target, key, receiver) {
        reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    store.setState({ taskMetaByEntityKey: entities });
    const before = store.getState();
    const notified = vi.fn();
    cleanups.push(store.subscribe(notified));
    store.getState().applyTaskMutation({
      previousTask: current,
      nextTask: { ...current },
      previousState: ACTIVE,
      nextState: ACTIVE,
    });
    expect({ enumerations, reads }).toEqual({ enumerations: 0, reads: 1 });
    expect(store.getState() === before).toBe(true);
    expect(notified.mock.calls.length).toBe(0);
  });

  it("updates entity metadata without publishing unchanged list references", () => {
    const current = task("current", { updatedAt: 20 });
    const other = task("other", { updatedAt: 10 });
    seed([current, other], {
      visible: query("timeline", [current, other]),
      pinned: query("pinned", []),
      archived: query("archived", []),
    });
    const before = store.getState();
    Object.freeze(before.taskMetaByEntityKey);
    Object.freeze(before.resultsByQueryKey);
    store.getState().applyTaskMutation({
      previousTask: current,
      nextTask: Object.freeze({ ...current, title: "Changed title" }),
      previousState: ACTIVE,
      nextState: ACTIVE,
    });
    const after = store.getState();
    expect(after.taskMetaByEntityKey[buildTaskEntityKey(current)]!.title).toBe("Changed title");
    expect(after.resultsByQueryKey).toBe(before.resultsByQueryKey);
    expect(before.taskMetaByEntityKey[buildTaskEntityKey(current)]!.title).toBe(current.title);
  });

  it("keeps invalidating search results even for identical metadata and membership", () => {
    const current = task("current");
    const search = query("timeline", [current], {
      stale: true,
      invalidationVersion: 7,
      searchSnippetsByTaskKey: { [buildTaskEntityKey(current)]: "body match" },
    });
    search.descriptor = { ...search.descriptor, search: "body" };
    seed([current], { search, visible: query("timeline", [current]) });
    const before = store.getState();
    store.getState().applyTaskMutation({
      previousTask: current,
      nextTask: { ...current },
      previousState: ACTIVE,
      nextState: ACTIVE,
    });
    const after = store.getState();
    expect(after.taskMetaByEntityKey).toBe(before.taskMetaByEntityKey);
    expect(after.resultsByQueryKey.visible).toBe(before.resultsByQueryKey.visible);
    expect(after.resultsByQueryKey.search).toEqual({
      ...search,
      stale: true,
      invalidationVersion: 8,
    });
    expect(after.resultsByQueryKey.search!.taskKeys).toBe(search.taskKeys);
  });

  it("moves membership and unread keys with correct total, hasMore and refill staleness", () => {
    const current = task("current", { unreadAt: 3 });
    const other = task("other");
    const key = buildTaskEntityKey(current);
    const timeline = query("timeline", [current, other], {
      total: 5,
      hasMore: true,
      unreadTaskKeys: [key],
    });
    timeline.descriptor = { ...timeline.descriptor, visibleLimit: 2 };
    seed([current, other], {
      timeline,
      pinned: query("pinned", [], { unreadTaskKeys: [] }),
      archived: query("archived", [], { unreadTaskKeys: [] }),
    });
    const before = store.getState();
    store.getState().applyTaskMutation({
      previousTask: current,
      nextTask: current,
      previousState: ACTIVE,
      nextState: PINNED,
    });
    const pinned = store.getState();
    expect(pinned.taskMetaByEntityKey).toBe(before.taskMetaByEntityKey);
    expect(pinned.resultsByQueryKey.timeline).toMatchObject({
      taskKeys: [buildTaskEntityKey(other)],
      unreadTaskKeys: [],
      total: 4,
      hasMore: true,
      stale: true,
    });
    expect(pinned.resultsByQueryKey.pinned).toMatchObject({
      taskKeys: [key],
      unreadTaskKeys: [key],
      total: 1,
      hasMore: false,
    });
    expect(pinned.resultsByQueryKey.archived).toBe(before.resultsByQueryKey.archived);
    applyTaskQueryCacheMutation({
      previousTask: current,
      nextTask: current,
      previousState: PINNED,
      nextState: ARCHIVED,
    });
    const archived = store.getState();
    expect(archived.resultsByQueryKey.pinned).toMatchObject({
      taskKeys: [],
      unreadTaskKeys: [],
      total: 0,
      hasMore: false,
    });
    expect(archived.resultsByQueryKey.archived).toMatchObject({
      taskKeys: [key],
      unreadTaskKeys: [key],
      total: 1,
      hasMore: false,
    });
    expect(timeline.taskKeys).toEqual([key, buildTaskEntityKey(other)]);
  });

  it("publishes unread-only changes while preserving absent unread-key fields", () => {
    const current = task("current");
    const key = buildTaskEntityKey(current);
    seed([current], {
      withUnread: query("workspace", [current], { unreadTaskKeys: [] }),
      withoutUnread: query("timeline", [current]),
    });
    const before = store.getState();
    store.getState().applyTaskMutation({
      previousTask: current,
      nextTask: { ...current, unreadAt: 3 },
      previousState: ACTIVE,
      nextState: ACTIVE,
    });
    const after = store.getState();
    expect(after.resultsByQueryKey.withUnread!.unreadTaskKeys).toEqual([key]);
    expect(after.resultsByQueryKey.withoutUnread).toBe(before.resultsByQueryKey.withoutUnread);
    expect(Object.hasOwn(after.resultsByQueryKey.withoutUnread!, "unreadTaskKeys")).toBe(false);
  });

  it("migrates entity keys immutably and replaces visible keys without changing totals", () => {
    const previous = task("before");
    const next = task("after");
    const previousKey = buildTaskEntityKey(previous);
    const nextKey = buildTaskEntityKey(next);
    seed([previous], { visible: query("timeline", [previous]) });
    const before = store.getState();
    Object.freeze(before.taskMetaByEntityKey);
    store.getState().applyTaskMutation({
      previousTask: previous,
      nextTask: next,
      previousState: ACTIVE,
      nextState: ACTIVE,
    });
    const after = store.getState();
    expect(Object.hasOwn(after.taskMetaByEntityKey, previousKey)).toBe(false);
    expect(after.taskMetaByEntityKey[nextKey]).toEqual(next);
    expect(after.resultsByQueryKey.visible).toMatchObject({
      taskKeys: [nextKey],
      total: 1,
      hasMore: false,
    });
    expect(before.taskMetaByEntityKey[previousKey]).toBe(previous);
  });

  it("inserts a new task and honors visible-limit ordering and absent-to-active totals", () => {
    const current = task("current", { updatedAt: 10 });
    const incoming = task("new", { updatedAt: 20 });
    const result = query("timeline", [current]);
    result.descriptor = { ...result.descriptor, visibleLimit: 1 };
    seed([current], { visible: result });
    store.getState().applyTaskMutation({
      previousTask: incoming,
      nextTask: incoming,
      previousState: { pinned: true, archived: true },
      nextState: ACTIVE,
    });
    expect(store.getState().resultsByQueryKey.visible).toMatchObject({
      taskKeys: [buildTaskEntityKey(incoming)],
      total: 2,
      hasMore: true,
      stale: true,
    });
    expect(store.getState().taskMetaByEntityKey[buildTaskEntityKey(incoming)]).toEqual(incoming);
  });

  it("does not insert metadata-only changes into a foreign workspace identity", () => {
    const current = task("shared", { workspaceIdentity: "identity-a" });
    const foreign = task("shared", { workspaceIdentity: "identity-b" });
    const result = query("timeline", [foreign]);
    result.descriptor = { ...result.descriptor, workspaceKeys: ["identity-b"] };
    seed([current, foreign], { visible: result });
    const before = store.getState();
    store.getState().applyTaskMutation({
      previousTask: current,
      nextTask: { ...current, title: "Changed" },
      previousState: ACTIVE,
      nextState: ACTIVE,
    });
    expect(store.getState().taskMetaByEntityKey[buildTaskEntityKey(foreign)]).toBe(foreign);
    expect(store.getState().resultsByQueryKey).toBe(before.resultsByQueryKey);
  });
});
