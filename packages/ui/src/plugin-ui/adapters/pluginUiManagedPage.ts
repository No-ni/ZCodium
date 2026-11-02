import { buildManagedPageController } from "./pluginUiManagedPageController.js";
import { readPluginUiStyleVariables } from "./readPluginUiStyleVariables.js";
import { pluginUiStateKey } from "@/plugin-ui/adapters/pluginUiStateKey.js";

import { logger } from "@/logger.js";

import type {
  PluginUiHostController,
  PluginUiHostPhase,
} from "@/plugin-ui/app/pluginUiHostController.js";

import { clearPluginUiWidgetState } from "@/plugin-ui/app/pluginUiWidgetStateStore.js";
import type { McpUiAppCapabilities } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { PluginSandboxHandle } from "@zcode/shared/mcp-apps";
import { buildPluginSandboxScopeId } from "@zcode/shared/mcp-apps";
import { clearPluginUiSurfaceFeed } from "../app/pluginUiSurfaceFeedStore.js";
import { PLUGIN_UI_CARD_DEFAULT_HEIGHT_PX } from "../contract.js";

import {
  appAllowsDisplayMode,
  buildPluginUiHostContext,
} from "@/plugin-ui/domain/buildPluginUiHostContext.js";

import { acquireWorkspaceConnection } from "@/v4/workspaceConnectionRegistry.js";
import type { IServiceAccessor } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { buildPluginUiSessionKey } from "../contract.js";
import type { Page, UsePluginUiHostInput, UsePluginUiHostResult } from "./pluginUiHostTypes.js";
import { createPluginUiPagePlane } from "./pluginUiPagePlane.js";
import { pluginUiPages } from "./pluginUiPageRegistry.js";
import { attachPluginUiResourceDeltaFeed } from "./pluginUiResourceDeltaFeed.js";
type Platform = IPlatformService;
type Services = IServiceAccessor;
export function createPage(
  key: string,
  input: UsePluginUiHostInput,
  platform: Platform,
  services: Services,
): Page {
  const bridge = services.pluginUiBridgeService!;
  const sandboxPlatform = platform.pluginSandbox!;
  const surfaceKey = key;
  const latest = { current: input };
  const listeners = new Set<() => void>();
  let surfaceStateKey: string | undefined;
  let controller: PluginUiHostController | null = null;
  let releaseFeed: (() => void) | undefined;
  let releaseLease: (() => void) | undefined;
  let executionKey = "";
  let disposed = false;
  let starting = false;
  let incarnation = 0;
  let releasing: Promise<unknown> = Promise.resolve();
  let recycling: Promise<boolean> | undefined;
  let activityFeed = "";
  let contextInputs = "";
  let lastFeed = "";
  let lastContext = "";
  let appIdentity: string | undefined;
  const notify = () => {
    for (const listener of listeners) listener();
  };
  let snapshot: UsePluginUiHostResult = {
    pageKey: key,
    supported: true,
    phase: "idle",
    handle: null,
    height: PLUGIN_UI_CARD_DEFAULT_HEIGHT_PX,
    error: null,
    appCapabilities: undefined,
    reload: () => {
      clearPluginUiWidgetState(key);
      void page.suspend(true).then(ensure);
    },
  };
  const patch = (value: Partial<UsePluginUiHostResult>) => {
    snapshot = { ...snapshot, ...value };
    notify();
  };
  const setPhase = (phase: PluginUiHostPhase) => patch({ phase });
  const setHandle = (handle: PluginSandboxHandle) => {
    if (appIdentity && appIdentity !== handle.instance.appIdentity) clearPluginUiWidgetState(key);
    appIdentity = handle.instance.appIdentity;
    const fresh =
      snapshot.handle?.sandboxId !== handle.sandboxId || snapshot.handle?.initId !== handle.initId;
    patch({ handle });
    if (fresh) pluginUiPages.prepared(page, handle.resourceMeta?.backgroundRetention === true);
    plane.mount(handle);
    syncExecution();
  };
  const setHeight = (height: number) => patch({ height });
  const setError = (error: string) => patch({ error });
  const syncDisplayModes = (appCapabilities: McpUiAppCapabilities | undefined) => {
    // 能力只有握手后才可知；之前在后台加载，避免 fullscreen-only 页面先闪现 inline。
    plane.setAllowedDisplayModes(
      appCapabilities === undefined
        ? []
        : (["inline", "fullscreen"] as const).filter((mode) =>
            appAllowsDisplayMode(
              appCapabilities,
              mode,
              latest.current.presentation.preferredDisplayMode,
            ),
          ),
    );
  };
  const setAppCapabilities = (appCapabilities: McpUiAppCapabilities | undefined) => {
    syncDisplayModes(appCapabilities);
    patch({ appCapabilities });
    if (appCapabilities)
      logger.lifecycle.info("[plugin-ui] display modes registered", {
        pluginId: latest.current.presentation.pluginId,
        scopeId: buildPluginSandboxScopeId(latest.current.scope.scope),
        availableDisplayModes: appCapabilities.availableDisplayModes ?? ["inline", "fullscreen"],
        preferredDisplayMode: latest.current.presentation.preferredDisplayMode,
      });
  };
  const plane = createPluginUiPagePlane({
    onVisibility(visible) {
      if (page.visible !== visible) pluginUiPages.visibility(page, visible);
      if (visible) ensure();
      syncExecution();
    },
    onCrash() {
      void page.suspend(true);
      patch({ phase: "error", error: "MCP App page stopped" });
    },
  });
  function syncExecution() {
    // 过去对所有页面强制维持后台帧，隐藏页也持续消耗 CPU；只有资源显式申请才启用。
    const active =
      controller !== null && snapshot.handle?.resourceMeta?.backgroundRetention === true;
    // 无锚点的冷启动也要完成握手；display:none 会让 Electron guest 无法首次挂载。
    // 仅启动阶段提供不可交互的承载面，握手后未声明的页面立即恢复普通隐藏策略。
    plane.setExecutionActive(active || (controller !== null && snapshot.phase !== "running"));
    const handle = snapshot.handle;
    if (!handle || !sandboxPlatform.setExecutionActive) return;
    const background = active && (!page.visible || document.hidden);
    const nextKey = `${handle.sandboxId}:${handle.initId}:${background}`;
    if (nextKey === executionKey) return;
    executionKey = nextKey;
    logger.lifecycle.info("[plugin-ui] background execution", {
      sessionId: input.scope.sessionId,
      sandboxId: handle.sandboxId,
      active: background,
    });
    void sandboxPlatform
      .setExecutionActive(handle.sandboxId, handle.initId, background)
      .catch((error: unknown) => {
        if (snapshot.handle !== handle || disposed) return;
        logger.warn("[plugin-ui] background execution failed", { error: String(error) });
      });
  }
  function onWindowVisibility() {
    if (!document.hidden && plane.hasVisibleAnchor()) void ensure();
    syncExecution();
  }
  async function ensure() {
    if (disposed || controller || starting || snapshot.phase === "error") return;
    starting = true;
    const epoch = ++incarnation;
    try {
      await releasing;
      surfaceStateKey = await pluginUiStateKey(surfaceKey);
      if (disposed || epoch !== incarnation) return;
      await pluginUiPages.reserve(page);
    } catch (error) {
      starting = false;
      patch({ phase: "error", error: String(error) });
      return;
    }
    if (disposed || epoch !== incarnation) {
      pluginUiPages.released(page);
      return;
    }
    starting = false;
    try {
      // 页面独立持有已有 workspace 连接租约；卡片或 pane 退出不会让后台页面失联。
      const connection = acquireWorkspaceConnection(
        latest.current.scope,
        services.zcodeAgentService,
        platform.createLocalMediaPreviewUrl,
      );
      releaseLease = () => connection.release();
      const lease = connection.layer.acquire(latest.current.scope.sessionId);
      const runtimeStopped = () => {
        void page.suspend(true);
        patch({ phase: "error", error: "MCP App runtime is no longer available" });
      };
      const offRestart = connection.transport.onRuntimeRestart(runtimeStopped);
      const offLifecycle = connection.transport.onRuntimeLifecycle?.((state) => {
        if (state === "unavailable") runtimeStopped();
      });
      releaseLease = () => {
        offRestart();
        offLifecycle?.();
        lease.release();
        connection.release();
      };
      releaseFeed = attachPluginUiResourceDeltaFeed(lease.store, latest.current.scope);
      patch({ phase: "preparing", error: null, handle: null });
      createController();
    } catch (error) {
      void page.suspend(true);
      patch({ phase: "error", error: String(error) });
    }
  }
  function createController() {
    controller = buildManagedPageController({
      latest,
      platform,
      services,
      key,
      surfaceKey,
      getController: () => controller,
      getSnapshot: () => snapshot,
      getPage: () => page,
      getSurfaceStateKey: () => surfaceStateKey,
      patch,
      setPhase,
      setHandle,
      setHeight,
      setError,
      setAppCapabilities,
    });
    controller.start();
  }
  const task = buildPluginUiSessionKey(input.scope);
  const workspaceEvents = services.zcodeTaskService.onDynamicWorkspaceEvent({
    workspacePath: input.scope.workspacePath,
    workspaceIdentity: input.scope.workspaceIdentity,
  })((event) => {
    if (
      event.type === "workspace_task_list_changed" &&
      event.reason === "task_deleted" &&
      event.taskId === input.scope.sessionId
    )
      pluginUiPages.removeTask(task);
  });
  const page: Page = {
    kind: "mcp",
    key,
    task,
    visible: false,
    snapshot: () => snapshot,
    start: () => void ensure(),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    busy: () => controller?.isBusy() ?? false,
    running: () => controller !== null || starting,
    bind(node, sidebar) {
      const off = plane.bind({
        node,
        kind: sidebar ? "sidebar" : "inline",
        container: node.closest<HTMLElement>("[data-sandbox-page-container]") ?? undefined,
      });
      ensure();
      return off;
    },
    update(next) {
      // 背景内联锚点不能覆盖侧栏当前的交互上下文。
      if (next.enabled === false) return;
      latest.current = next;
      // 只重选展示锚点，绝不销毁或重载 WebView；插件的未保存状态仍留在同一 guest。
      syncDisplayModes(snapshot.appCapabilities);
      const nextContextInputs = JSON.stringify([
        next.theme,
        next.locale,
        next.displayMode,
        next.width,
        next.titleBar,
        next.availableDisplayModes,
        next.presentation.preferredDisplayMode,
      ]);
      if (nextContextInputs !== contextInputs) {
        contextInputs = nextContextInputs;
        const context = buildPluginUiHostContext({
          theme: next.theme,
          locale: next.locale,
          displayMode: next.displayMode,
          width: next.width,
          titleBar: next.titleBar,
          availableDisplayModes: next.availableDisplayModes,
          styleVariables: readPluginUiStyleVariables(),
        });
        const contextKey = JSON.stringify(context);
        if (contextKey !== lastContext) {
          lastContext = contextKey;
          controller?.updateHostContext(context);
        }
      }
      page.updateToolFeed(next);
    },
    updateToolFeed(next) {
      if (disposed) return;
      const activityKey = JSON.stringify([
        next.toolCallId,
        Boolean(next.toolResult),
        next.toolCancelled,
      ]);
      if (next.toolCallId && activityKey !== activityFeed) {
        activityFeed = activityKey;
        pluginUiPages.activity(page);
        void ensure();
      }
      latest.current = {
        ...latest.current,
        toolCallId: next.toolCallId,
        toolInput: next.toolInput,
        toolResult: next.toolResult,
        toolCancelled: next.toolCancelled,
      };
      const feed = JSON.stringify([
        next.toolCallId,
        next.toolInput,
        next.toolResult,
        next.toolCancelled,
      ]);
      if (feed !== lastFeed) {
        lastFeed = feed;
        if (next.toolInput) controller?.notifyToolInput({ arguments: next.toolInput });
        if (next.toolResult) controller?.notifyToolResult(next.toolResult);
        if (next.toolCancelled) controller?.notifyToolCancelled();
      }
    },
    async suspend(force = false) {
      if (!force) {
        if (recycling) return recycling;
        if (starting || !pluginUiPages.claimRecycle(page)) return false;
        const candidate = controller;
        const attempt = (async () => {
          if (candidate && !(await candidate.tryRecycle().catch(() => false))) return false;
          // Agent 原子裁决 busy/审批；等待期间被重载或删除的旧 controller 不得释放新实例。
          if (candidate !== controller || disposed) return false;
          await page.suspend(true);
          // 裁决期间用户可能重新打开；旧凭证已撤销，必须从同一 owner 重建。
          if (!document.hidden && !disposed && plane.hasVisibleAnchor()) void ensure();
          return true;
        })();
        recycling = attempt;
        try {
          return await attempt;
        } finally {
          if (recycling === attempt) recycling = undefined;
          pluginUiPages.finishRecycle(page);
        }
      }
      incarnation++;
      starting = false;
      const previous = controller;
      controller = null;
      plane.setExecutionActive(false);
      executionKey = "";
      const previousHandle = snapshot.handle;
      const offFeed = releaseFeed,
        offLease = releaseLease;
      releaseFeed = undefined;
      releaseLease = undefined;
      patch({ phase: "idle", handle: null, appCapabilities: undefined });
      plane.setAllowedDisplayModes([]);
      // 先前释放未完成时不能重新预备；反复重试也只等待同一个释放链。
      // Main 主动导航到 about:blank 会触发 navigation；先解除旧代际观察，避免回收被误报为崩溃。
      if (previousHandle) plane.prepareUnmount(previousHandle.sandboxId);
      const closing = previous?.dispose();
      releasing = Promise.all([releasing, closing]).then(() => {
        if (previousHandle) plane.unmount(previousHandle.sandboxId);
        offFeed?.();
        offLease?.();
        pluginUiPages.released(page);
      });
      await releasing;
      return true;
    },
    destroy() {
      document.removeEventListener("visibilitychange", onWindowVisibility);
      workspaceEvents.dispose();
      clearPluginUiSurfaceFeed(key);
      disposed = true;
      void page.suspend(true).finally(() => plane.dispose());
      clearPluginUiWidgetState(key);
      listeners.clear();
    },
  };
  plane.setAllowedDisplayModes([]);
  document.addEventListener("visibilitychange", onWindowVisibility);
  return page;
}
