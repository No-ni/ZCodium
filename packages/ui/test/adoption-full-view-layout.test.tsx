import { beforeEach, describe, expect, it, vi } from "vitest";
import { ResizablePanelGroup } from "../src/components/ui/resizable.js";
import type { GroupImperativeHandle, Layout } from "react-resizable-panels";

const harness = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { value: unknown; deps?: readonly unknown[] }[],
  effects: [] as (() => void)[],
  pending: [] as (() => void)[],
  writes: [] as [string, string][],
}));
vi.mock("react", async (importActual) => {
  const actual = await importActual<typeof import("react")>();
  const memo = <T,>(factory: () => T, deps: readonly unknown[]) => {
    const index = harness.cursor++;
    const previous = harness.slots[index];
    if (!previous || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) {
      harness.slots[index] = { value: factory(), deps };
    }
    return harness.slots[index]!.value as T;
  };
  return {
    ...actual,
    useRef: <T,>(value: T) => {
      const index = harness.cursor++;
      harness.slots[index] ??= { value: { current: value } };
      return harness.slots[index]!.value;
    },
    useMemo: memo,
    useCallback: <T,>(callback: T, deps: readonly unknown[]) => memo(() => callback, deps),
    useLayoutEffect: (effect: () => void, deps: readonly unknown[]) => {
      const index = harness.cursor++;
      const previous = harness.slots[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) {
        harness.effects.push(effect);
        harness.slots[index] = { value: null, deps };
      }
    },
  };
});
vi.mock("react-resizable-panels", () => ({
  Group: () => null,
  Panel: () => null,
  Separator: () => null,
  useDefaultLayout: ({ id, storage }: { id: string; storage: Storage }) => ({
    defaultLayout: { conversation: 75, preview: 25 },
    onLayoutChange: (layout: Layout) =>
      harness.pending.push(() => storage.setItem(id, JSON.stringify(layout))),
  }),
}));

type GroupProjection = {
  groupRef:
    | { current: GroupImperativeHandle | null }
    | ((value: GroupImperativeHandle | null) => void);
  onLayoutChange: (layout: Layout) => void;
};
function render(
  suspended: boolean,
  groupRef?: { current: GroupImperativeHandle | null },
  layoutId = "fixture-layout",
) {
  harness.cursor = 0;
  harness.effects = [];
  const element = ResizablePanelGroup({
    layoutId,
    suspendLayoutPersistence: suspended,
    ...(groupRef ? { groupRef } : {}),
  });
  return element.props as GroupProjection;
}
function attach(projection: GroupProjection, api: GroupImperativeHandle) {
  if (typeof projection.groupRef === "function") projection.groupRef(api);
  else projection.groupRef.current = api;
}
function commit() {
  for (const effect of harness.effects) effect();
}
function flush() {
  for (const write of harness.pending.splice(0)) write();
}

describe("full-view resizable layout projection", () => {
  beforeEach(() => {
    harness.cursor = 0;
    harness.slots = [];
    harness.effects = [];
    harness.pending = [];
    harness.writes = [];
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: (key: string, value: string) => harness.writes.push([key, value]),
    });
  });
  it("blocks an already-queued persistence write while suspended", () => {
    const normal = render(false);
    normal.onLayoutChange({ conversation: 65, preview: 35 });
    render(true);
    flush();
    expect(harness.writes).toEqual([]);
  });
  it("restores the last normal layout, not child resize measurements from either transition", () => {
    let layout = { conversation: 65, preview: 35 };
    const restored: Layout[] = [];
    const api = {
      getLayout: () => layout,
      setLayout: (next: Layout) => {
        restored.push(next);
        return next;
      },
    };
    const normal = render(false);
    attach(normal, api);
    normal.onLayoutChange(layout);
    commit();
    const floating = render(true);
    layout = { conversation: 20, preview: 80 };
    floating.onLayoutChange(layout);
    commit();
    const exiting = render(false);
    exiting.onLayoutChange(layout);
    commit();
    expect(restored).toEqual([{ conversation: 65, preview: 35 }]);
    flush();
    expect(harness.writes.map(([, value]) => JSON.parse(value))).not.toContainEqual(layout);
  });
  it("keeps a caller's imperative ref without replacing the internal restoration owner", () => {
    const external = { current: null as GroupImperativeHandle | null };
    const restored: Layout[] = [];
    const api = {
      getLayout: () => ({ conversation: 70, preview: 30 }),
      setLayout: (layout: Layout) => {
        restored.push(layout);
        return layout;
      },
    };
    const normal = render(false, external);
    attach(normal, api);
    normal.onLayoutChange({ conversation: 70, preview: 30 });
    commit();
    render(true, external);
    commit();
    render(false, external);
    commit();
    expect(external.current).toBe(api);
    expect(restored).toEqual([{ conversation: 70, preview: 30 }]);
  });
  it("does not restore one layout identity into another group", () => {
    const restored: Layout[] = [];
    const api = {
      getLayout: () => ({ conversation: 20, preview: 80 }),
      setLayout: (layout: Layout) => {
        restored.push(layout);
        return layout;
      },
    };
    const normal = render(false);
    attach(normal, api);
    normal.onLayoutChange({ conversation: 70, preview: 30 });
    commit();
    render(true);
    commit();
    render(false, undefined, "another-layout");
    commit();
    expect(restored).toEqual([]);
  });
});
