import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IGitService, IServiceAccessor } from "@zcode/services";
import type { GitRefreshResult } from "@zcode/shared";

const fixture = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  effects: [] as (() => void)[],
  services: {} as IServiceAccessor,
  remoteSessionId: "remote-session" as string | null,
}));
interface EffectSlot {
  dependencies: readonly unknown[];
  effect: () => (() => void) | undefined;
  cleanup?: () => void;
}
// 沿用 workflow query 专测的无 DOM harness，先 cleanup 再执行新 effect。
vi.mock("react", () => ({
  useState(initial: unknown) {
    const i = fixture.cursor++;
    if (!(i in fixture.slots))
      fixture.slots[i] = typeof initial === "function" ? initial() : initial;
    return [
      fixture.slots[i],
      (v: unknown) => {
        fixture.slots[i] = typeof v === "function" ? v(fixture.slots[i]) : v;
      },
    ];
  },
  useRef(initial: unknown) {
    const i = fixture.cursor++;
    return (fixture.slots[i] ??= { current: initial });
  },
  useEffect(effect: () => (() => void) | undefined, dependencies: readonly unknown[]) {
    const i = fixture.cursor++;
    const previous = fixture.slots[i] as EffectSlot | undefined;
    if (
      previous?.dependencies.length === dependencies.length &&
      dependencies.every((v, index) => Object.is(v, previous.dependencies[index]))
    )
      return;
    const slot: EffectSlot = { dependencies, effect };
    fixture.slots[i] = slot;
    fixture.effects.push(() => {
      previous?.cleanup?.();
      slot.cleanup = effect();
    });
  },
  useMemo(factory: () => unknown) {
    return factory();
  },
}));
vi.mock("@/hooks/useServices.js", () => ({ useServices: () => fixture.services }));
vi.mock("@/hooks/useResolvedRemoteWorkspaceSessionId.js", () => ({
  useResolvedRemoteWorkspaceSessionId: () => fixture.remoteSessionId,
}));
vi.mock("@/logger.js", () => ({ logger: { warn: vi.fn() } }));
import { useGitRepository } from "./useGitRepository.js";
import { logger } from "@/logger.js";

const options: Parameters<typeof useGitRepository>[0] = {
  workspacePath: "/synthetic/repo",
  workspaceIdentity: "synthetic-remote-identity",
  remoteSessionId: "remote-session",
  activeTaskId: null,
  refreshToken: 0,
};
function result(branchName: string): GitRefreshResult {
  return {
    summary: {
      workspacePath: options.workspacePath,
      repoRoot: options.workspacePath,
      workspaceInRepoPath: ".",
      autoRefreshWatchPaths: [{ path: `/synthetic/${branchName}/.git`, recursive: false }],
      branchName,
      trackingBranchName: null,
      headRefType: "branch",
      ahead: 0,
      behind: 0,
      isDirty: false,
      isGitAvailable: true,
      isRepository: true,
    },
    identity: null,
    unstagedChanges: [],
    stagedChanges: [],
    branchComparison: null,
  };
}
function service(refresh: IGitService["refresh"]): IGitService {
  return { refresh } as IGitService;
}
function useService(gitService: IGitService) {
  fixture.services = { gitService } as IServiceAccessor;
}
function render(input = options) {
  fixture.cursor = 0;
  fixture.effects = [];
  return useGitRepository(input);
}
async function flush() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}
async function commit() {
  const effects = fixture.effects;
  fixture.effects = [];
  for (const effect of effects) effect();
  await flush();
}
async function mount(git: IGitService) {
  useService(git);
  render();
  await commit();
}
beforeEach(() => {
  fixture.slots = [];
  fixture.effects = [];
  fixture.cursor = 0;
  fixture.remoteSessionId = "remote-session";
  vi.clearAllMocks();
});
afterEach(() => {
  for (const slot of fixture.slots) (slot as EffectSlot | null)?.cleanup?.();
});

describe("Git repository service generation", () => {
  it.each(["success", "failure"] as const)(
    "restarts after StrictMode effect replay and ignores the old %s",
    async (completion) => {
      const first = Promise.withResolvers<GitRefreshResult>();
      const second = Promise.withResolvers<GitRefreshResult>();
      const refresh = vi
        .fn<IGitService["refresh"]>()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      await mount(service(refresh));
      const effects = fixture.slots.filter(
        (slot): slot is EffectSlot => typeof slot === "object" && slot !== null && "effect" in slot,
      );
      for (const slot of effects) slot.cleanup?.();
      for (const slot of effects) slot.cleanup = slot.effect();
      await flush();
      expect(refresh).toHaveBeenCalledTimes(2);
      if (completion === "success") first.resolve(result("obsolete"));
      else first.reject(new Error("obsolete setup"));
      await flush();
      expect(render()).toMatchObject({ loading: true, error: null, summary: { branchName: null } });
      expect(logger.warn).not.toHaveBeenCalled();
      second.resolve(result("current"));
      await flush();
      expect(render()).toMatchObject({
        loading: false,
        error: null,
        summary: { branchName: "current" },
      });
    },
  );

  it("accepts an in-flight extended superset after closing the same-source pane without rereading", async () => {
    const pending = Promise.withResolvers<GitRefreshResult>();
    const refresh = vi.fn<IGitService["refresh"]>().mockReturnValue(pending.promise);
    useService(service(refresh));
    render({ ...options, includeExtendedData: true });
    await commit();
    expect(render({ ...options, includeExtendedData: true }).loading).toBe(true);
    render({ ...options, includeExtendedData: false });
    await commit();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith({
      workspacePath: options.workspacePath,
      includeIdentity: true,
      includeBranchComparison: true,
    });
    pending.resolve(result("extended"));
    await flush();
    expect(render({ ...options, includeExtendedData: false })).toMatchObject({
      loading: false,
      error: null,
      summary: { branchName: "extended" },
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it.each(["success", "failure"] as const)(
    "still rejects the extended %s after closing and then unmounting",
    async (completion) => {
      const pending = Promise.withResolvers<GitRefreshResult>();
      const refresh = vi.fn<IGitService["refresh"]>().mockReturnValue(pending.promise);
      useService(service(refresh));
      render({ ...options, includeExtendedData: true });
      await commit();
      render({ ...options, includeExtendedData: false });
      await commit();
      for (const slot of fixture.slots) (slot as EffectSlot | null)?.cleanup?.();
      const before = JSON.stringify(fixture.slots);
      if (completion === "success") pending.resolve(result("unmounted"));
      else pending.reject(new Error("unmounted request"));
      await flush();
      expect(JSON.stringify(fixture.slots)).toBe(before);
      expect(logger.warn).not.toHaveBeenCalled();
      expect(refresh).toHaveBeenCalledTimes(1);
    },
  );
  it("still rejects A after closing its pane and replacing the source with B", async () => {
    const pending = Promise.withResolvers<GitRefreshResult>();
    const a = vi.fn<IGitService["refresh"]>().mockReturnValue(pending.promise);
    const b = vi.fn<IGitService["refresh"]>().mockResolvedValue(result("B"));
    useService(service(a));
    render({ ...options, includeExtendedData: true });
    await commit();
    render({ ...options, includeExtendedData: false });
    await commit();
    useService(service(b));
    render({ ...options, includeExtendedData: false });
    await commit();
    pending.resolve(result("late-A"));
    await flush();
    expect(render()).toMatchObject({ loading: false, error: null, summary: { branchName: "B" } });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
  it("does not requery the same service across accessor rewraps and task rerenders", async () => {
    const refresh = vi.fn<IGitService["refresh"]>().mockResolvedValue(result("A"));
    const git = service(refresh);
    await mount(git);
    useService(git);
    render({ ...options, activeTaskId: "other-task" });
    await commit();
    render({ ...options, activeTaskId: "other-task" });
    await commit();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it("requeries a changed resolved remoteSessionId even when the service is reused", async () => {
    const refresh = vi.fn<IGitService["refresh"]>().mockResolvedValue(result("A"));
    await mount(service(refresh));
    fixture.remoteSessionId = "next-session";
    const next = { ...options, remoteSessionId: "next-session" };
    refresh.mockResolvedValue(result("B"));
    expect(render(next).summary.branchName).toBeNull();
    await commit();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(render(next).summary.branchName).toBe("B");
  });
  it("reads B once after settled A at the same scope and refresh token", async () => {
    const a = vi.fn<IGitService["refresh"]>().mockResolvedValue(result("A"));
    const pending = Promise.withResolvers<GitRefreshResult>();
    const b = vi.fn<IGitService["refresh"]>().mockReturnValue(pending.promise);
    await mount(service(a));
    expect(render().summary.branchName).toBe("A");
    useService(service(b));
    render();
    await commit();
    expect(b).toHaveBeenCalledTimes(1);
    expect(render().summary.branchName).toBeNull();
    pending.resolve(result("B"));
    await flush();
    expect(render()).toMatchObject({ loading: false, error: null, summary: { branchName: "B" } });
    expect(a).toHaveBeenCalledTimes(1);
  });
  it("hides A watcher paths before B's replacement effect runs", async () => {
    await mount(service(vi.fn<IGitService["refresh"]>().mockResolvedValue(result("A"))));
    useService(service(vi.fn<IGitService["refresh"]>().mockResolvedValue(result("B"))));
    const firstB = render();
    expect(firstB.summary.branchName).toBeNull();
    expect(firstB.summary.autoRefreshWatchPaths).toEqual([]);
    await commit();
    expect(render().summary.autoRefreshWatchPaths).toEqual(
      result("B").summary.autoRefreshWatchPaths,
    );
  });
  it.each(["success", "failure"] as const)(
    "starts B while A is pending and ignores A's late %s",
    async (completion) => {
      const aPending = Promise.withResolvers<GitRefreshResult>();
      const bPending = Promise.withResolvers<GitRefreshResult>();
      const a = vi.fn<IGitService["refresh"]>().mockReturnValue(aPending.promise);
      const b = vi.fn<IGitService["refresh"]>().mockReturnValue(bPending.promise);
      await mount(service(a));
      useService(service(b));
      render();
      await commit();
      expect(b).toHaveBeenCalledTimes(1);
      if (completion === "success") aPending.resolve(result("late-A"));
      else aPending.reject(new Error("old attachment closed"));
      await flush();
      expect(render()).toMatchObject({ loading: true, error: null, summary: { branchName: null } });
      expect(logger.warn).not.toHaveBeenCalled();
      bPending.resolve(result("B"));
      await flush();
      expect(render()).toMatchObject({ loading: false, error: null, summary: { branchName: "B" } });
    },
  );
});
