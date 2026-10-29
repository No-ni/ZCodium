import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WindowHostControllerTaskListItem } from "@zcode/services";
import type { WorkspaceTabState } from "@/store/tabStore.js";

// 沿用 workflow query 专测的有限 hook runner：slot 化 useState/useRef/useMemo，
// 手动 commit 模拟订阅与 effect，不引入 DOM 或真实 registry。
const fixture = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  effects: [] as (() => void)[],
  revision: 0,
  controller: {} as unknown,
  taskListVersions: new Map<string, number>(),
  errors: [] as unknown[][],
  registry: {
    subscribe: vi.fn(),
    getRevision: (): number => 0,
    list: vi.fn(),
  },
}));
function sameDependencies(previous: readonly unknown[] | undefined, next: readonly unknown[]) {
  return (
    previous?.length === next.length &&
    next.every((value, index) => Object.is(value, previous[index]))
  );
}
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const index = fixture.cursor++;
    if (!(index in fixture.values))
      fixture.values[index] =
        typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [
      fixture.values[index],
      (value: unknown) => {
        fixture.values[index] =
          typeof value === "function"
            ? (value as (prev: unknown) => unknown)(fixture.values[index])
            : value;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const index = fixture.cursor++;
    fixture.values[index] ??= { current: initial };
    return fixture.values[index] as { current: unknown };
  },
  useEffect: (effect: () => unknown, dependencies: readonly unknown[]) => {
    const index = fixture.cursor++;
    const previous = fixture.values[index] as
      | { dependencies: readonly unknown[]; cleanup?: () => void }
      | undefined;
    if (sameDependencies(previous?.dependencies, dependencies)) return;
    const slot = { dependencies, cleanup: undefined as (() => void) | undefined };
    fixture.values[index] = slot;
    fixture.effects.push(() => {
      previous?.cleanup?.();
      slot.cleanup = effect() as (() => void) | undefined;
    });
  },
  useCallback: (callback: unknown, dependencies: readonly unknown[]) => {
    const index = fixture.cursor++;
    const previous = fixture.values[index] as
      | { dependencies: readonly unknown[]; callback: unknown }
      | undefined;
    if (sameDependencies(previous?.dependencies, dependencies)) return previous?.callback;
    fixture.values[index] = { dependencies, callback };
    return callback;
  },
  // 与线上语义一致：按依赖缓存，避免 workspaceScopes/query 每帧换引用导致 effect 误重跑。
  useMemo: (factory: () => unknown, dependencies: readonly unknown[]) => {
    const index = fixture.cursor++;
    const previous = fixture.values[index] as
      | { dependencies: readonly unknown[]; value: unknown }
      | undefined;
    if (sameDependencies(previous?.dependencies, dependencies)) return previous?.value;
    const value = factory();
    fixture.values[index] = { dependencies, value };
    return value;
  },
  useSyncExternalStore: (
    subscribe: (onChange: () => void) => () => void,
    getSnapshot: () => number,
  ) => {
    const index = fixture.cursor++;
    const previous = fixture.values[index] as
      | { subscribe: unknown; cleanup?: () => void }
      | undefined;
    if (previous && previous.subscribe === subscribe) return getSnapshot();
    const slot = { subscribe, cleanup: undefined as (() => void) | undefined };
    fixture.values[index] = slot;
    fixture.effects.push(() => {
      previous?.cleanup?.();
      slot.cleanup = subscribe(() => {});
    });
    return getSnapshot();
  },
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => ({ windowControllerService: fixture.controller }),
}));
vi.mock("@/store/zcodeSessionStore.js", () => ({
  selectWorkspaceZCodeState: (_state: unknown, workspacePath: string) => ({
    taskListVersion: fixture.taskListVersions.get(workspacePath) ?? 0,
  }),
  useZCodeSessionStore: (selector: (state: unknown) => string) => selector({}),
}));
vi.mock("@/logger.js", () => ({
  logger: {
    error: (...args: unknown[]) => fixture.errors.push(args),
    warn: vi.fn(),
  },
}));
vi.mock("@/v4/windowControllerTaskListRegistry.js", () => ({
  getWindowControllerTaskListRegistry: (controller: unknown) =>
    controller && controller === fixture.controller ? fixture.registry : null,
}));
import { useGlobalTaskList } from "./useGlobalTaskList.js";

const tabA: WorkspaceTabState = {
  id: "a",
  label: "Synthetic A",
  kind: "workspace",
  workspacePath: "/synth/a",
};
const tabB: WorkspaceTabState = {
  id: "b",
  label: "Synthetic B",
  kind: "workspace",
  workspacePath: "/synth/b",
};
function item(taskId: string, workspacePath = "/synth/a"): WindowHostControllerTaskListItem {
  return {
    taskId,
    traceId: `trace-${taskId}`,
    title: taskId,
    workspacePath,
    status: "completed",
    liveStatus: "completed",
    sourceAvailability: "online",
    mode: "build",
    createdAt: 1,
    updatedAt: 1,
  };
}

type HookParams = Parameters<typeof useGlobalTaskList>[0];
function baseParams(overrides: Partial<HookParams> = {}): HookParams {
  return {
    kind: "active",
    workspaceTabs: [tabA],
    sortBy: "updated",
    searchQuery: "",
    expanded: true,
    collapsedLimit: 0,
    ...overrides,
  };
}
function render(overrides: Partial<HookParams> = {}) {
  fixture.cursor = 0;
  fixture.effects = [];
  return useGlobalTaskList(baseParams(overrides));
}
async function commit() {
  const effects = fixture.effects;
  fixture.effects = [];
  for (const effect of effects) effect();
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
function unmount() {
  for (const value of fixture.values) {
    const cleanup = (value as { cleanup?: () => void } | null)?.cleanup;
    cleanup?.();
  }
}
function listCalls() {
  return fixture.registry.list.mock.calls as unknown as [
    string,
    { controllerRevision: number; taskListVersionSignature: string; manualRefreshSerial?: number },
    { search?: string; workspaceScopes: { workspacePath: string }[] },
  ][];
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.values = [];
  fixture.cursor = 0;
  fixture.effects = [];
  fixture.revision = 0;
  fixture.controller = {};
  fixture.taskListVersions = new Map();
  fixture.errors = [];
  fixture.registry.subscribe = vi.fn(() => () => {});
  fixture.registry.getRevision = () => fixture.revision;
  fixture.registry.list = vi.fn();
});
afterEach(() => {
  unmount();
});

describe("useGlobalTaskList disabled gate", () => {
  it("loads, then keeps the last trusted list when disabled without querying or erroring", async () => {
    fixture.registry.list.mockResolvedValue({ items: [item("t1")], total: 1, hasMore: false });
    render();
    await commit();
    expect(fixture.registry.subscribe).toHaveBeenCalledTimes(1);
    expect(listCalls()).toHaveLength(1);
    expect(render().items).toHaveLength(1);

    const disabled = render({ enabled: false, workspaceTabs: [tabA, tabB] });
    await commit();
    expect(disabled.loading).toBe(false);
    expect(fixture.registry.subscribe).toHaveBeenCalledTimes(1);
    expect(listCalls()).toHaveLength(1);
    expect(fixture.errors).toEqual([]);
    const kept = render({ enabled: false, workspaceTabs: [tabA, tabB] });
    // 禁用不清空：保留最后可信列表，只停 loading。
    expect(kept.items).toHaveLength(1);
    expect(kept.total).toBe(1);
    expect(kept.loading).toBe(false);
    expect(kept.syncingRemoteWorkspaces).toBe(false);

    // 手动 refresh 走同一门禁：禁用时不查询、不报错。
    await kept.refresh();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(listCalls()).toHaveLength(1);
    expect(fixture.errors).toEqual([]);
  });

  it("ignores task revision, source generation and refresh traffic while mounted disabled", async () => {
    render({ enabled: false });
    await commit();
    expect(fixture.registry.subscribe).not.toHaveBeenCalled();
    expect(listCalls()).toHaveLength(0);
    expect(fixture.errors).toEqual([]);
    expect(render({ enabled: false }).loading).toBe(false);

    fixture.revision = 5;
    fixture.taskListVersions.set("/synth/a", 3);
    render({ enabled: false });
    await commit();
    expect(listCalls()).toHaveLength(0);
    expect(fixture.errors).toEqual([]);

    // remoteSessionId 换代同样不得触发查询。
    const remoteTab: WorkspaceTabState = {
      ...tabA,
      remoteSessionId: "sess-2",
    };
    const view = render({ enabled: false, workspaceTabs: [remoteTab] });
    await commit();
    expect(listCalls()).toHaveLength(0);
    expect(fixture.errors).toEqual([]);
    await view.refresh();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(listCalls()).toHaveLength(0);
    expect(fixture.errors).toEqual([]);
  });

  it("still clears when the workspace scope is empty", async () => {
    fixture.registry.list.mockResolvedValue({ items: [item("t1")], total: 1, hasMore: true });
    render();
    await commit();
    expect(render().items).toHaveLength(1);
    render({ workspaceTabs: [] });
    await commit();
    const cleared = render({ workspaceTabs: [] });
    expect(cleared.items).toEqual([]);
    expect(cleared.total).toBe(0);
    expect(cleared.hasMore).toBe(false);
    expect(cleared.loading).toBe(false);
    render({ enabled: false, workspaceTabs: [] });
    await commit();
    const clearedDisabled = render({ enabled: false, workspaceTabs: [] });
    expect(clearedDisabled.items).toEqual([]);
    expect(clearedDisabled.loading).toBe(false);
  });

  it.each(["success", "failure"])(
    "drops a late %s from an in-flight request after unmount",
    async (outcome) => {
      const pending = Promise.withResolvers<{
        items: WindowHostControllerTaskListItem[];
        total: number;
        hasMore: boolean;
      }>();
      fixture.registry.list.mockReturnValue(pending.promise);
      render();
      await commit();
      unmount();
      const snapshot = JSON.stringify(fixture.values);
      if (outcome === "success") {
        pending.resolve({ items: [item("late")], total: 1, hasMore: false });
      } else {
        pending.reject(new Error("late host failure"));
      }
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
      expect(JSON.stringify(fixture.values)).toBe(snapshot);
      expect(fixture.errors).toEqual([]);
    },
  );

  it("invalidates in-flight requests when disabled and re-reads current facts on re-enable", async () => {
    const first = Promise.withResolvers<{
      items: WindowHostControllerTaskListItem[];
      total: number;
      hasMore: boolean;
    }>();
    fixture.registry.list.mockReturnValueOnce(first.promise);
    render();
    await commit();
    render({ enabled: false });
    await commit();
    expect(fixture.errors).toEqual([]);
    first.resolve({ items: [item("stale")], total: 1, hasMore: false });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    // 禁用期间迟到成功不得写入；重新启用必须复用原入口读取当前事实。
    expect(render({ enabled: false }).items).toEqual([]);
    const second = Promise.withResolvers<{
      items: WindowHostControllerTaskListItem[];
      total: number;
      hasMore: boolean;
    }>();
    fixture.registry.list.mockReturnValueOnce(second.promise);
    fixture.revision = 9;
    fixture.taskListVersions.set("/synth/a", 4);
    render();
    await commit();
    expect(listCalls()).toHaveLength(2);
    const last = listCalls()[1]![1];
    expect(last.controllerRevision).toBe(9);
    expect(last.taskListVersionSignature).toContain("4");
    second.resolve({ items: [item("current")], total: 1, hasMore: false });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(render().items.map((row) => row.taskId)).toEqual(["current"]);
  });

  it("reports a genuinely missing Controller channel only while enabled", async () => {
    fixture.controller = null;
    render();
    await commit();
    expect(fixture.errors).toHaveLength(1);
    expect(String(fixture.errors[0]![0])).toContain("channel unavailable");
    expect(listCalls()).toHaveLength(0);
    expect(render().loading).toBe(false);

    fixture.errors = [];
    render({ enabled: false });
    await commit();
    expect(fixture.errors).toEqual([]);
  });

  it("discards a stale query-generation response when the query changes", async () => {
    const stale = Promise.withResolvers<{
      items: WindowHostControllerTaskListItem[];
      total: number;
      hasMore: boolean;
    }>();
    const fresh = Promise.withResolvers<{
      items: WindowHostControllerTaskListItem[];
      total: number;
      hasMore: boolean;
    }>();
    fixture.registry.list.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);
    render();
    await commit();
    render({ searchQuery: "alpha" });
    await commit();
    expect(listCalls()).toHaveLength(2);
    expect(listCalls()[1]![2].search).toBe("alpha");
    stale.resolve({ items: [item("stale")], total: 1, hasMore: false });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(render({ searchQuery: "alpha" }).items).toEqual([]);
    fresh.resolve({ items: [item("fresh")], total: 1, hasMore: false });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(render({ searchQuery: "alpha" }).items.map((row) => row.taskId)).toEqual(["fresh"]);
  });
});
