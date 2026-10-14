import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  effects: [] as (() => unknown)[],
  artifacts: vi.fn(),
  workspace: vi.fn(),
  nodeResult: vi.fn(),
  artifactRead: vi.fn(),
  artifactData: vi.fn(),
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
      fixture.values[index] = typeof initial === "function" ? initial() : initial;
    return [
      fixture.values[index],
      (value: unknown) => {
        fixture.values[index] = typeof value === "function" ? value(fixture.values[index]) : value;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const index = fixture.cursor++;
    fixture.values[index] ??= { current: initial };
    return fixture.values[index];
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
  useMemo: (factory: () => unknown) => factory(),
}));
vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({
    workflowRunArtifacts: fixture.artifacts,
    workflowRunWorkspace: fixture.workspace,
    workflowRunNodeResult: fixture.nodeResult,
    workflowRunArtifactRead: fixture.artifactRead,
    workflowRunArtifactData: fixture.artifactData,
  }),
}));
import { useWorkflowRunArtifacts } from "./useWorkflowRunArtifacts.js";
import { useWorkflowRunWorkspace } from "./useWorkflowRunWorkspace.js";
import { useWorkflowRunNodeResult } from "./useWorkflowRunNodeResult.js";
import { useWorkflowRunArtifactBytes } from "./useWorkflowRunArtifactBytes.js";
import { useWorkflowRunArtifactData } from "./useWorkflowRunArtifactData.js";

const root = "/workspace/session/nested";
const options = { sessionId: "parent", runId: "run" };
function render<T>(hook: () => T): T {
  fixture.cursor = 0;
  fixture.effects = [];
  return hook();
}
async function effects() {
  fixture.effects.forEach((effect) => effect());
  await Promise.resolve();
  await Promise.resolve();
}
beforeEach(() => {
  fixture.values = [];
  fixture.cursor = 0;
  fixture.effects = [];
  vi.clearAllMocks();
});
afterEach(() => {
  for (const value of fixture.values) {
    const cleanup = (value as { cleanup?: () => void } | null)?.cleanup;
    cleanup?.();
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("workflow query hooks keep run execution metadata with the matching response", () => {
  it.each(
    ["bytes", "data"].flatMap((kind) =>
      [
        "run",
        "session",
        "artifact",
        "reader",
        "enabled",
        ...(kind === "bytes" ? ["version"] : []),
      ].map((scope) => [kind, scope]),
    ),
  )("hides previous artifact %s before %s effects run", async (kind, scope) => {
    fixture.artifactRead.mockResolvedValue({
      dataBase64: btoa("old"),
      mediaType: "text/plain",
      totalBytes: 3,
      nextOffset: null,
    });
    fixture.artifactData.mockResolvedValue({
      items: [{ sequence: 1, data: "old" }],
      hasMore: false,
    });
    const query = { ...options, artifactId: "artifact", version: 1, enabled: true };
    const read = (input: typeof query) =>
      kind === "bytes" ? useWorkflowRunArtifactBytes(input) : useWorkflowRunArtifactData(input);
    render(() => read(query));
    await effects();
    const old = render(() => read(query));
    expect("bytes" in old ? old.bytes?.length : old.items.length).toBeGreaterThan(0);
    if (scope === "reader") {
      if (kind === "bytes") fixture.artifactRead = vi.fn();
      else fixture.artifactData = vi.fn();
    }
    const next = render(() =>
      read({
        ...query,
        ...(scope === "run" ? { runId: "new" } : {}),
        ...(scope === "session" ? { sessionId: "new" } : {}),
        ...(scope === "artifact" ? { artifactId: "new" } : {}),
        ...(scope === "version" ? { version: 2 } : {}),
        ...(scope === "enabled" ? { enabled: false } : {}),
      }),
    );
    expect("bytes" in next ? next.bytes : next.items).toEqual(kind === "bytes" ? null : []);
    if ("objectUrl" in next) expect(next.objectUrl).toBeNull();
    expect(next.error).toBeNull();
    // 执行清理，验证任务不留下 object URL。
    await effects();
  });

  it.each(["run", "reader", "enabled"])(
    "starts a new drain on %s switch while the old one is pending",
    async (scope) => {
      const old = Promise.withResolvers<never>();
      const current = Promise.withResolvers<{ items: unknown[]; hasMore: boolean }>();
      fixture.artifactData = vi
        .fn()
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(current.promise)
        .mockResolvedValue({ items: [{ sequence: 2, data: "second" }], hasMore: false });
      const first = { ...options, artifactId: "artifact", itemCount: 0 };
      render(() => useWorkflowRunArtifactData(first));
      await effects();
      const oldReader = fixture.artifactData;
      const next = { ...first, ...(scope === "run" ? { runId: "new" } : {}) };
      if (scope === "reader")
        fixture.artifactData = vi.fn((...args: unknown[]) => oldReader(...args));
      if (scope === "enabled") {
        render(() => useWorkflowRunArtifactData({ ...first, enabled: false }));
        await effects();
      }
      render(() => useWorkflowRunArtifactData(next));
      await effects();
      expect(oldReader).toHaveBeenCalledTimes(2);
      old.reject(new Error("old Host disconnected"));
      await Promise.resolve();
      await Promise.resolve();
      render(() => useWorkflowRunArtifactData({ ...next, itemCount: 1 }));
      await effects();
      expect(oldReader).toHaveBeenCalledTimes(2);
      current.resolve({ items: [{ sequence: 1, data: "first" }], hasMore: false });
      await Promise.resolve();
      await Promise.resolve();
      expect(oldReader).toHaveBeenCalledTimes(3);
      expect(fixture.artifactData).toHaveBeenLastCalledWith({
        sessionId: "parent",
        runId: next.runId,
        artifactId: "artifact",
        afterSequence: 1,
        limit: 200,
      });
      expect(render(() => useWorkflowRunArtifactData({ ...next, itemCount: 1 })).items).toEqual([
        { sequence: 1, data: "first" },
        { sequence: 2, data: "second" },
      ]);
    },
  );

  it("does not write artifact data after unmount", async () => {
    const pending = Promise.withResolvers<{ items: unknown[]; hasMore: boolean }>();
    fixture.artifactData = vi.fn().mockReturnValue(pending.promise);
    render(() => useWorkflowRunArtifactData({ ...options, artifactId: "unmount" }));
    await effects();
    const cleanups = fixture.values.filter(
      (value) => typeof (value as { cleanup?: unknown })?.cleanup === "function",
    ) as { cleanup: () => void }[];
    expect(cleanups.length).toBeGreaterThan(0);
    for (const entry of cleanups) entry.cleanup();
    const before = JSON.stringify(fixture.values);
    pending.resolve({ items: [{ sequence: 1, data: "late" }], hasMore: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(JSON.stringify(fixture.values)).toBe(before);
  });

  it.each(
    ["artifacts", "workspace"].flatMap((kind) =>
      ["run", "session", "reader", "enabled"].map((scope) => [kind, scope]),
    ),
  )("hides the previous %s response before %s effects run", async (kind, scope) => {
    const query = kind === "artifacts" ? fixture.artifacts : fixture.workspace;
    query.mockResolvedValue({
      artifacts: [{ id: "old", kind: "content", version: 1, versions: [], itemCount: 0 }],
      nodes: [{ siteId: "old" }],
      executionWorkspacePath: root,
      truncated: true,
    });
    const read = (input: typeof options & { enabled?: boolean }) =>
      kind === "artifacts" ? useWorkflowRunArtifacts(input) : useWorkflowRunWorkspace(input);
    render(() => read(options));
    await effects();
    expect(render(() => read(options)).executionWorkspacePath).toBe(root);
    if (scope === "reader") {
      if (kind === "artifacts") fixture.artifacts = vi.fn();
      else fixture.workspace = vi.fn();
    }
    const next = render(() =>
      read({
        ...options,
        ...(scope === "run" ? { runId: "next" } : {}),
        ...(scope === "session" ? { sessionId: "next" } : {}),
        ...(scope === "enabled" ? { enabled: false } : {}),
      }),
    );
    expect(next.executionWorkspacePath).toBeUndefined();
    expect("artifacts" in next ? next.artifacts : next.nodes).toEqual([]);
    expect(next).toMatchObject({ loading: false, unavailable: false, error: null });
    expect("complete" in next ? next.complete : next.loaded).toBe(false);
    if ("truncated" in next) expect(next.truncated).toBe(false);
  });
  it("isolates node bodies across Hosts while reusing settled bodies in the same Host", async () => {
    const query = { ...options, siteId: "host-isolation", ordinal: 0 };
    const oldBody = { status: "completed", result: "old Host", truncated: false, totalBytes: 8 };
    const newBody = { ...oldBody, result: "new Host" };
    fixture.nodeResult = vi.fn().mockResolvedValue(oldBody);
    render(() => useWorkflowRunNodeResult(query));
    await effects();
    expect(render(() => useWorkflowRunNodeResult(query)).result).toEqual(oldBody);
    fixture.values = [];
    render(() => useWorkflowRunNodeResult(query));
    await effects();
    expect(fixture.nodeResult).toHaveBeenCalledTimes(1);
    fixture.nodeResult = vi.fn().mockResolvedValue(newBody);
    expect(render(() => useWorkflowRunNodeResult(query)).result).toBeNull();
    await effects();
    expect(fixture.nodeResult).toHaveBeenCalledWith(query);
    expect(render(() => useWorkflowRunNodeResult(query)).result).toEqual(newBody);
  });
  it("discards a previous Host's pending node response", async () => {
    const query = { ...options, siteId: "pending-host", ordinal: 0 };
    let settle!: (value: unknown) => void;
    fixture.nodeResult = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    render(() => useWorkflowRunNodeResult(query));
    await effects();
    const newBody = { status: "completed", result: "new Host", truncated: false, totalBytes: 8 };
    fixture.nodeResult = vi.fn().mockResolvedValue(newBody);
    render(() => useWorkflowRunNodeResult(query));
    await effects();
    settle({ ...newBody, result: "old Host" });
    await Promise.resolve();
    expect(render(() => useWorkflowRunNodeResult(query)).result).toEqual(newBody);
  });
  it("fetches the frozen root even when live artifact metadata exists, and clears it on run change", async () => {
    fixture.artifacts.mockResolvedValueOnce({ artifacts: [], executionWorkspacePath: root });
    render(() => useWorkflowRunArtifacts({ ...options, live: [] }));
    await effects();
    expect(fixture.artifacts).toHaveBeenCalledWith(options);
    expect(
      render(() => useWorkflowRunArtifacts({ ...options, live: [] })).executionWorkspacePath,
    ).toBe(root);
    fixture.artifacts.mockResolvedValueOnce({ artifacts: [] });
    render(() => useWorkflowRunArtifacts({ ...options, runId: "older-host" }));
    await effects();
    expect(
      render(() => useWorkflowRunArtifacts({ ...options, runId: "older-host" }))
        .executionWorkspacePath,
    ).toBeUndefined();
  });
  it("discards a stale artifact response including its root after switching runs", async () => {
    let settle!: (value: unknown) => void;
    fixture.artifacts.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    render(() => useWorkflowRunArtifacts(options));
    await effects();
    fixture.artifacts.mockResolvedValueOnce({ artifacts: [], executionWorkspacePath: "/new" });
    render(() => useWorkflowRunArtifacts({ ...options, runId: "new" }));
    await effects();
    settle({ artifacts: [], executionWorkspacePath: root });
    await Promise.resolve();
    expect(
      render(() => useWorkflowRunArtifacts({ ...options, runId: "new" })).executionWorkspacePath,
    ).toBe("/new");
  });
  it("returns the transcript root from its node response and omits it for older hosts", async () => {
    fixture.workspace.mockResolvedValueOnce({ nodes: [], executionWorkspacePath: root });
    render(() => useWorkflowRunWorkspace(options));
    await effects();
    expect(render(() => useWorkflowRunWorkspace(options)).executionWorkspacePath).toBe(root);
    fixture.workspace.mockResolvedValueOnce({ nodes: [] });
    render(() => useWorkflowRunWorkspace({ ...options, runId: "old" }));
    await effects();
    expect(
      render(() => useWorkflowRunWorkspace({ ...options, runId: "old" })).executionWorkspacePath,
    ).toBeUndefined();
  });
  it("discards the previous transcript response and pending refresh after switching runs", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    let settle!: (value: unknown) => void;
    fixture.workspace.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    render(() => useWorkflowRunWorkspace({ ...options, refreshSignal: 100 }));
    await effects();
    render(() => useWorkflowRunWorkspace({ ...options, refreshSignal: 101 }));
    await effects();
    fixture.workspace.mockResolvedValueOnce({ nodes: [], executionWorkspacePath: "/new" });
    const next = { ...options, runId: "new", refreshSignal: 1 };
    render(() => useWorkflowRunWorkspace(next));
    await effects();
    settle({ nodes: [], executionWorkspacePath: root });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);
    expect(fixture.workspace).toHaveBeenCalledTimes(2);
    expect(render(() => useWorkflowRunWorkspace(next)).executionWorkspacePath).toBe("/new");
  });
  it.each(["run", "session", "host", "enabled"])(
    "resets the transcript refresh watermark on %s switch",
    async (scope) => {
      vi.useFakeTimers();
      vi.stubGlobal("window", globalThis);
      fixture.workspace.mockResolvedValue({ nodes: [], executionWorkspacePath: root });
      render(() => useWorkflowRunWorkspace({ ...options, refreshSignal: 100 }));
      await effects();
      const next = {
        ...options,
        ...(scope === "run" ? { runId: "new" } : {}),
        ...(scope === "session" ? { sessionId: "new-parent" } : {}),
        refreshSignal: 1,
      };
      if (scope === "host") {
        fixture.workspace = vi.fn().mockResolvedValue({ nodes: [] });
      }
      if (scope === "enabled") {
        render(() => useWorkflowRunWorkspace({ ...options, enabled: false, refreshSignal: 100 }));
        await effects();
      }
      render(() => useWorkflowRunWorkspace(next));
      await effects();
      const initialCalls = scope === "host" ? 1 : 2;
      expect(fixture.workspace).toHaveBeenCalledTimes(initialCalls);
      render(() => useWorkflowRunWorkspace({ ...next, refreshSignal: 2 }));
      await effects();
      await vi.advanceTimersByTimeAsync(250);
      expect(fixture.workspace).toHaveBeenCalledTimes(initialCalls + 1);
      expect(fixture.workspace).toHaveBeenLastCalledWith({
        sessionId: next.sessionId,
        runId: next.runId,
      });
    },
  );
});
