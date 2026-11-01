import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsSyncAgent, SettingsSyncDiscoveryResult } from "@zcode/shared";

// ── 内存 React 渲染器（真实 React，非手写 hook 复刻）──
// 仓库未安装 DOM/testing-library，且本任务禁止新增依赖。这里用仓库 node_modules 中已有的
// react-reconciler（0.33.0，peer react ^19.2.0，与已装 react 19.2.7 匹配；react-test-renderer
// 同样构建在它之上）搭一个纯内存渲染器：hook、effect、state、清理全部由真实 React 执行，
// 只把 host 面置空（用例组件返回 null，不产生 host 实例）。react 与 react-reconciler 都经
// createRequire 装载，保证与 ESM 侧是同一 CJS 实例（dispatcher 共享）。
const require_ = createRequire(import.meta.url);
const reactModule = require_("react") as typeof import("react");
const reactReconciler = require_("react-reconciler") as { default?: unknown } & Record<
  string,
  unknown
>;
const Reconciler = (reactReconciler.default ?? reactReconciler) as (config: unknown) => {
  createContainer: (
    container: unknown,
    tag: number,
    hydrationCallbacks: null,
    isStrictMode: boolean,
    concurrentUpdates: boolean,
    identifierPrefix: string,
    logError: null,
    transitionCallbacks: null,
  ) => unknown;
  updateContainerSync: (children: unknown, root: unknown, callback: null) => void;
  flushPassiveEffects: () => void;
};
const { act, createElement } = reactModule;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noop = () => undefined;
const memoryHostConfig = {
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  isPrimaryRenderer: true,
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  noTimeout: -1,
  now: () => Date.now(),
  warnsIfNotActing: true,
  getRootHostContext: () => ({}),
  getChildHostContext: () => ({}),
  createTextInstance: () => {
    throw new Error("text host instances are not used by hook harnesses");
  },
  createInstance: () => {
    throw new Error("host components are not used by hook harnesses");
  },
  appendInitialChild: noop,
  appendChild: noop,
  appendChildToContainer: noop,
  insertBefore: noop,
  insertInContainerBefore: noop,
  removeChild: noop,
  removeChildFromContainer: noop,
  commitUpdate: noop,
  commitTextUpdate: noop,
  resetTextContent: noop,
  hideInstance: noop,
  unhideInstance: noop,
  hideTextInstance: noop,
  unhideTextInstance: noop,
  clearContainer: noop,
  finalizeInitialChildren: () => false,
  prepareUpdate: () => null,
  shouldSetTextContent: () => false,
  prepareForCommit: () => null,
  resetAfterCommit: noop,
  getPublicInstance: (instance: unknown) => instance,
  getInstanceFromNode: () => null,
  preparePortalMount: noop,
  beforeActiveInstanceBlur: noop,
  afterActiveInstanceBlur: noop,
  prepareScopeUpdate: noop,
  getInstanceFromScope: () => null,
  detachDeletedInstance: noop,
  maySuspendCommit: () => false,
  maySuspendCommitOnUpdate: () => false,
  maySuspendCommitInSyncRender: () => false,
  preloadInstance: () => true,
  startSuspendingCommit: noop,
  suspendInstance: noop,
  waitForCommitToBeReady: () => null,
  // React 19 shared host config 的事件/优先级面：react-dom 从 window.event 取值，
  // 内存渲染器没有事件系统，给确定常量即可（不影响 hook/effect 语义）。
  resolveEventTimeStamp: () => -1.1,
  resolveEventType: () => null,
  trackSchedulerEvent: noop,
  setCurrentUpdatePriority: noop,
  getCurrentUpdatePriority: () => 16,
  resolveUpdatePriority: () => 16,
  shouldAttemptEagerTransition: () => false,
};

interface HarnessRenderer {
  render: (element: unknown) => Promise<void>;
  unmount: () => Promise<void>;
}

function createHarnessRenderer(): HarnessRenderer {
  const renderer = Reconciler(memoryHostConfig);
  const root = renderer.createContainer({}, 0, null, false, false, "settings-sync", null, null);
  const settle = async () => {
    renderer.flushPassiveEffects();
    // loadDiscovery 内部有 await 链（getFirstRunPromptState → detect），
    // 给足宏任务轮次让在途 continuation 全部收敛，再复查状态。
    for (let turn = 0; turn < 4; turn += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    renderer.flushPassiveEffects();
  };
  return {
    render: async (element: unknown) => {
      await act(async () => {
        renderer.updateContainerSync(element, root, null);
        await settle();
      });
    },
    unmount: async () => {
      await act(async () => {
        renderer.updateContainerSync(null, root, null);
        await settle();
      });
    },
  };
}

// ── 被测 hook 的依赖 mock（只 mock 边界，hook 本体与 React 都是真实的）──
// service 对象必须是稳定引用：生产 useServices 返回同一个 accessor，loadDiscovery 与首启
// effect 的依赖才不会每帧换身份；若 mock 每次渲染新建对象，effect 会无限重跑（测试陷阱）。
const fixture = vi.hoisted(() => ({
  settingsSyncService: {
    detect: vi.fn(),
    markFirstRunPromptHandled: vi.fn(async () => undefined),
    getFirstRunPromptState: vi.fn(async () => ({ handled: false })),
    importSelected: vi.fn(),
  },
  zcodeSessionService: {},
}));
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({
    settingsSyncService: fixture.settingsSyncService,
    zcodeSessionService: fixture.zcodeSessionService,
  }),
}));
vi.mock("@/hooks/useZCodeSessionService.js", () => ({
  useZCodeSessionService: () => fixture.zcodeSessionService,
}));
vi.mock("@/lib/zcodeDraftSkillInvalidation.js", () => ({
  invalidateDeferredDraftSessionForSkillChange: vi.fn(async () => undefined),
}));
vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { useSettingsSync } from "./useSettingsSync.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const EMPTY_DISCOVERY: SettingsSyncDiscoveryResult = { agents: [] };
function discoveryFor(agent: SettingsSyncAgent): SettingsSyncDiscoveryResult {
  return {
    agents: [
      {
        agent,
        discovered: true,
        categories: [
          {
            category: "providers",
            discoveredCount: 1,
            importableCount: 1,
            selectedByDefault: true,
          },
        ],
      },
    ],
  };
}
const settleTurns = async () => {
  for (let turn = 0; turn < 4; turn += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
};

let latest: ReturnType<typeof useSettingsSync> | undefined;
function Harness(props: { workspacePath?: string; workspaceIdentity?: string }) {
  latest = useSettingsSync(props);
  return null;
}
const mount = (
  renderer: HarnessRenderer,
  props: { workspacePath?: string; workspaceIdentity?: string },
) => renderer.render(createElement(Harness, props));

beforeEach(() => {
  vi.clearAllMocks();
  latest = undefined;
  fixture.settingsSyncService.getFirstRunPromptState.mockImplementation(async () => ({
    handled: false,
  }));
  fixture.settingsSyncService.markFirstRunPromptHandled.mockImplementation(async () => undefined);
  fixture.settingsSyncService.detect.mockReset();
});

describe("useSettingsSync 首启 discovery 陈旧回包边界", () => {
  it("切换 workspace 后，旧 scope 的非空 detect 回包不覆盖新 scope 的 discovery", async () => {
    const oldScope = createDeferred<SettingsSyncDiscoveryResult>();
    const newScope = createDeferred<SettingsSyncDiscoveryResult>();
    fixture.settingsSyncService.detect.mockImplementation((params: { workspacePath: string }) =>
      params.workspacePath === "ws-old" ? oldScope.promise : newScope.promise,
    );
    const renderer = createHarnessRenderer();
    await mount(renderer, { workspacePath: "ws-old" });
    await mount(renderer, { workspacePath: "ws-new" });
    newScope.resolve(discoveryFor("codexCli"));
    await settleTurns();
    expect(latest?.state.open).toBe(true);
    expect(latest?.state.discovery?.agents[0]?.agent).toBe("codexCli");
    oldScope.resolve(discoveryFor("claudeCode"));
    await settleTurns();
    expect(latest?.state.discovery?.agents[0]?.agent).toBe("codexCli");
    expect(latest?.state.open).toBe(true);
    expect(fixture.settingsSyncService.markFirstRunPromptHandled).not.toHaveBeenCalled();
  });

  it("切换 workspace 后，旧 scope 的空 detect 回包不标记 handled、不重置新 scope 状态", async () => {
    const oldScope = createDeferred<SettingsSyncDiscoveryResult>();
    const newScope = createDeferred<SettingsSyncDiscoveryResult>();
    fixture.settingsSyncService.detect.mockImplementation((params: { workspacePath: string }) =>
      params.workspacePath === "ws-old" ? oldScope.promise : newScope.promise,
    );
    const renderer = createHarnessRenderer();
    await mount(renderer, { workspacePath: "ws-old" });
    await mount(renderer, { workspacePath: "ws-new" });
    newScope.resolve(discoveryFor("codexCli"));
    await settleTurns();
    oldScope.resolve(EMPTY_DISCOVERY);
    await settleTurns();
    expect(fixture.settingsSyncService.markFirstRunPromptHandled).not.toHaveBeenCalled();
    expect(latest?.state.open).toBe(true);
    expect(latest?.state.discovery?.agents[0]?.agent).toBe("codexCli");
  });

  it("切换 workspace 后，旧 scope 的 detect 失败回包不打开错误态弹窗", async () => {
    const oldScope = createDeferred<SettingsSyncDiscoveryResult>();
    const newScope = createDeferred<SettingsSyncDiscoveryResult>();
    fixture.settingsSyncService.detect.mockImplementation((params: { workspacePath: string }) =>
      params.workspacePath === "ws-old" ? oldScope.promise : newScope.promise,
    );
    const renderer = createHarnessRenderer();
    await mount(renderer, { workspacePath: "ws-old" });
    await mount(renderer, { workspacePath: "ws-new" });
    newScope.resolve(discoveryFor("codexCli"));
    await settleTurns();
    oldScope.reject(new Error("stale detect failure"));
    await settleTurns();
    expect(latest?.state.error).toBeNull();
    expect(latest?.state.open).toBe(true);
    expect(latest?.state.discovery?.agents[0]?.agent).toBe("codexCli");
  });

  it("仅 workspaceIdentity 变化（同 path）时，旧 scope 回包同样不得覆盖新 scope", async () => {
    const oldScope = createDeferred<SettingsSyncDiscoveryResult>();
    const newScope = createDeferred<SettingsSyncDiscoveryResult>();
    fixture.settingsSyncService.detect.mockImplementation(
      (params: { workspaceIdentity?: string }) =>
        params.workspaceIdentity === undefined ? oldScope.promise : newScope.promise,
    );
    const renderer = createHarnessRenderer();
    await mount(renderer, { workspacePath: "ws" });
    await mount(renderer, { workspacePath: "ws", workspaceIdentity: "remote:1" });
    newScope.resolve(discoveryFor("qwenCode"));
    await settleTurns();
    oldScope.resolve(discoveryFor("roo"));
    await settleTurns();
    expect(latest?.state.discovery?.agents[0]?.agent).toBe("qwenCode");
    expect(fixture.settingsSyncService.markFirstRunPromptHandled).not.toHaveBeenCalled();
  });

  it("卸载后，旧 scope 的空 detect 回包不得再触发 mark", async () => {
    const oldScope = createDeferred<SettingsSyncDiscoveryResult>();
    fixture.settingsSyncService.detect.mockImplementation(() => oldScope.promise);
    const renderer = createHarnessRenderer();
    await mount(renderer, { workspacePath: "ws-old" });
    await renderer.unmount();
    oldScope.resolve(EMPTY_DISCOVERY);
    await settleTurns();
    expect(fixture.settingsSyncService.markFirstRunPromptHandled).not.toHaveBeenCalled();
  });

  it("无竞态的正常首启：非空 discovery 打开弹窗并带默认选中，detect 入参字段保持", async () => {
    const scope = createDeferred<SettingsSyncDiscoveryResult>();
    fixture.settingsSyncService.detect.mockImplementation(() => scope.promise);
    const renderer = createHarnessRenderer();
    await mount(renderer, { workspacePath: "ws-a" });
    scope.resolve(discoveryFor("goose"));
    await settleTurns();
    expect(latest?.state.open).toBe(true);
    expect(latest?.state.step).toBe("selection");
    expect(latest?.state.discovery?.agents[0]?.agent).toBe("goose");
    expect(latest?.state.selectedKeys).toEqual(["goose:providers"]);
    expect(fixture.settingsSyncService.detect).toHaveBeenCalledTimes(1);
    expect(fixture.settingsSyncService.detect).toHaveBeenCalledWith({
      workspacePath: "ws-a",
      workspaceIdentity: undefined,
    });
  });

  it("handled 已处理时不调用 detect，状态保持初始", async () => {
    fixture.settingsSyncService.getFirstRunPromptState.mockImplementation(async () => ({
      handled: true,
    }));
    const renderer = createHarnessRenderer();
    await mount(renderer, { workspacePath: "ws-a" });
    await settleTurns();
    expect(fixture.settingsSyncService.detect).not.toHaveBeenCalled();
    expect(latest?.state.open).toBe(false);
    expect(fixture.settingsSyncService.markFirstRunPromptHandled).not.toHaveBeenCalled();
  });

  it("manual reopen 的空 discovery 仍保持欢迎页打开，且不重复 mark", async () => {
    const firstRun = createDeferred<SettingsSyncDiscoveryResult>();
    const manual = createDeferred<SettingsSyncDiscoveryResult>();
    let call = 0;
    fixture.settingsSyncService.detect.mockImplementation(() => {
      call += 1;
      return call === 1 ? firstRun.promise : manual.promise;
    });
    const renderer = createHarnessRenderer();
    await mount(renderer, { workspacePath: "ws-a" });
    // 当前 scope 的空结果是有效 mark：首启提示应被标记并回到初始态。
    firstRun.resolve(EMPTY_DISCOVERY);
    await settleTurns();
    expect(fixture.settingsSyncService.markFirstRunPromptHandled).toHaveBeenCalledTimes(1);
    expect(latest?.state.open).toBe(false);
    latest?.actions.reopen();
    await settleTurns();
    manual.resolve(EMPTY_DISCOVERY);
    await settleTurns();
    expect(latest?.state.open).toBe(true);
    expect(latest?.state.discovery?.agents).toEqual([]);
    expect(fixture.settingsSyncService.markFirstRunPromptHandled).toHaveBeenCalledTimes(1);
  });

  it("mark 在途期间切换 workspace：有效 mark 恰好一次，旧 await 后的 reset 不覆盖新 dialog", async () => {
    const firstRun = createDeferred<SettingsSyncDiscoveryResult>();
    const newScope = createDeferred<SettingsSyncDiscoveryResult>();
    // 与 hoisted fixture 的 markFirstRunPromptHandled 实现返回类型（Promise<undefined>）对齐。
    const pendingMark = createDeferred<undefined>();
    let detectCall = 0;
    fixture.settingsSyncService.detect.mockImplementation(() => {
      detectCall += 1;
      return detectCall === 1 ? firstRun.promise : newScope.promise;
    });
    // 旧 scope 的 mark 发起后在途挂起，模拟 app-global 持久化写的真实往返。
    fixture.settingsSyncService.markFirstRunPromptHandled.mockImplementation(
      () => pendingMark.promise,
    );
    const renderer = createHarnessRenderer();
    await mount(renderer, { workspacePath: "ws-a", workspaceIdentity: "id-a" });
    // 空 detect 到达时 A 仍是当前 scope：mark 是被发出的有效请求，必须保留（不倒退）。
    firstRun.resolve(EMPTY_DISCOVERY);
    await settleTurns();
    expect(fixture.settingsSyncService.markFirstRunPromptHandled).toHaveBeenCalledTimes(1);
    // mark 未完成期间切到新 workspace + identity，并让新 scope 的非空 discovery 打开弹窗。
    await mount(renderer, { workspacePath: "ws-b", workspaceIdentity: "id-b" });
    newScope.resolve(discoveryFor("codexCli"));
    await settleTurns();
    expect(latest?.state.open).toBe(true);
    expect(latest?.state.discovery?.agents[0]?.agent).toBe("codexCli");
    // 旧 mark 此时才完成：app-global mark 仍恰好一次，且旧 await 之后的
    // setState(createInitialState()) 不得把新 scope 的 dialog/agents 重置掉。
    pendingMark.resolve(undefined);
    await settleTurns();
    expect(fixture.settingsSyncService.markFirstRunPromptHandled).toHaveBeenCalledTimes(1);
    expect(latest?.state.open).toBe(true);
    expect(latest?.state.step).toBe("selection");
    expect(latest?.state.discovery?.agents[0]?.agent).toBe("codexCli");
  });
});
