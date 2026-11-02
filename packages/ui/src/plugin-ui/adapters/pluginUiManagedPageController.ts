import { getPluginUiSessionActions } from "./pluginUiSessionActions.js";
import { createPluginUiMessagePortTransport } from "@/plugin-ui/adapters/messagePortTransport.js";
import { createPluginUiDownloadInteraction } from "@/plugin-ui/adapters/pluginUiDownloads.js";
import { readPluginUiStyleVariables } from "@/plugin-ui/adapters/readPluginUiStyleVariables.js";
import { createPluginUiResourceNotificationRegistrar } from "@/plugin-ui/app/pluginUiResourceNotificationBus.js";
import { buildPluginUiHostCapabilities } from "../domain/buildPluginUiHostCapabilities.js";
import {
  createPluginUiHostController,
  type PluginUiHostController,
  type PluginUiHostPhase,
} from "../app/pluginUiHostController.js";
import {
  getPluginUiWidgetState,
  setPluginUiWidgetState,
  clearPluginUiWidgetState,
} from "../app/pluginUiWidgetStateStore.js";
import { logger } from "@/logger.js";
import { buildPluginUiHostContext } from "../domain/buildPluginUiHostContext.js";
import { pluginUiPages } from "./pluginUiPageRegistry.js";
import { buildPluginSandboxScopeId, type PluginSandboxHandle } from "@zcode/shared/mcp-apps";
import type {
  McpUiHostContext,
  McpUiAppCapabilities,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type { IServiceAccessor } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { PLUGIN_UI_CARD_MIN_HEIGHT_PX, PLUGIN_UI_CARD_MAX_HEIGHT_PX } from "../contract.js";
import type { Page, UsePluginUiHostInput, UsePluginUiHostResult } from "./pluginUiHostTypes.js";

interface ManagedPageControllerContext {
  latest: { current: UsePluginUiHostInput };
  platform: IPlatformService;
  services: IServiceAccessor;
  key: string;
  surfaceKey: string;
  getController(): PluginUiHostController | null;
  getSnapshot(): UsePluginUiHostResult;
  getPage(): Page;
  getSurfaceStateKey(): string | undefined;
  patch(value: Partial<UsePluginUiHostResult>): void;
  setPhase(phase: PluginUiHostPhase): void;
  setHandle(handle: PluginSandboxHandle): void;
  setHeight(height: number): void;
  setError(error: string): void;
  setAppCapabilities(capabilities: McpUiAppCapabilities | undefined): void;
}

// 页面 owner 通过 getter 保留实时身份；这里只构造一次控制器并返回，start 仍在 owner 完成赋值后执行。
export function buildManagedPageController({
  latest,
  platform,
  services,
  key,
  surfaceKey,
  getController,
  getSnapshot,
  getPage,
  getSurfaceStateKey,
  patch,
  setPhase,
  setHandle,
  setHeight,
  setError,
  setAppCapabilities,
}: ManagedPageControllerContext): PluginUiHostController {
  const bridge = services.pluginUiBridgeService!;
  const sandboxPlatform = platform.pluginSandbox!;

  const initialHostContext: McpUiHostContext = buildPluginUiHostContext({
    theme: latest.current.theme,
    locale: latest.current.locale,
    displayMode: latest.current.displayMode,
    width: latest.current.width,
    ...(latest.current.titleBar ? { titleBar: latest.current.titleBar } : {}),
    ...(latest.current.availableDisplayModes
      ? { availableDisplayModes: latest.current.availableDisplayModes }
      : {}),
    // 主题 token 随初始 hostContext 下发，主题切换时经 updateHostContext 更新。
    styleVariables: readPluginUiStyleVariables(),
  });
  const scope = latest.current.scope;
  const presentation = latest.current.presentation;
  // 平台交互（downloadFile）与调用方注入的会话交互合成一份；能力声明按合成后的回调是否存在。
  const platformInteractions = createPluginUiDownloadInteraction({
    platform,
    bridge,
    scope,
    presentation,
    getInstance: () => {
      const handle = getSnapshot().handle;
      if (!handle) throw new Error("MCP App is not prepared");
      return handle.instance;
    },
  });
  const nextController = createPluginUiHostController({
    bridge,
    sampling: services?.pluginUiSamplingService,
    ...(services?.pluginUiAppToolsService ? { appTools: services.pluginUiAppToolsService } : {}),
    createTransport: createPluginUiMessagePortTransport,
    platform: sandboxPlatform,
    scope,
    presentation,
    // 按代际登记到路由表；该会话的投影 store 收到 pluginUi.* 增量后按 (scopeId, generation) 投递。
    resourceNotifications: createPluginUiResourceNotificationRegistrar(
      scope,
      presentation.serverName,
    ),
    initialHostContext,
    getPreferredDisplayMode: () => latest.current.presentation.preferredDisplayMode,
    hostVersion: latest.current.hostVersion,
    getToolFeed: () => ({
      ...(latest.current.toolInput ? { toolInput: { arguments: latest.current.toolInput } } : {}),
      ...(latest.current.toolResult ? { toolResult: latest.current.toolResult } : {}),
      ...(latest.current.toolCancelled ? { toolCancelled: true } : {}),
    }),
    // widgetState 初值直接读宿主内存 store（唯一 owner），不经 props 再缓存一份；
    // 端口投递时才读；切换展示位置仍使用同一 guest 与内存状态。
    getWidgetState: () => getPluginUiWidgetState(surfaceKey),
    getHostCapabilities: () =>
      buildPluginUiHostCapabilities({
        canSendFollowUpMessage: Boolean(latest.current.interactions?.onSendFollowUpMessage),
        canUpdateModelContext: Boolean(latest.current.interactions?.onUpdateModelContext),
        canSetWidgetState: true,
        canSample: Boolean(services?.pluginUiSamplingService && getPluginUiSessionActions(scope)),
        canSubscribeResources: true,
        canDownloadFile: Boolean(platformInteractions?.onDownloadFile),
        ...(scope.scope.kind === "surface"
          ? { surfaceId: scope.scope.surfaceId, surfaceStateKey: getSurfaceStateKey() }
          : {}),
      }),
    ...platformInteractions,
    // 经 latest ref 转调，回调 identity 变化不触发 controller 重建；缺省回 -32601（端口层翻译成 ProtocolError）。
    onSendFollowUpMessage: (payload, context) =>
      latest.current.interactions?.onSendFollowUpMessage
        ? latest.current.interactions.onSendFollowUpMessage(payload, context)
        : Promise.reject(Object.assign(new Error("Not supported"), { code: -32601 })),
    onUpdateModelContext: (payload) =>
      latest.current.interactions?.onUpdateModelContext
        ? latest.current.interactions.onUpdateModelContext(payload)
        : Promise.reject(Object.assign(new Error("Not supported"), { code: -32601 })),
    onUpdateWidgetState: async (widgetState) => {
      setPluginUiWidgetState(surfaceKey, widgetState);
    },
    onPhase: (next, detail) => {
      if (getController() !== nextController) return;
      // 生命周期事件每个沙箱只有几条，走 lifecycle 才能进主日志（排查用户现场用）。
      logger.lifecycle.info("[plugin-ui] lifecycle", {
        phase: next,
        sessionId: latest.current.scope.sessionId,
        pluginId: latest.current.presentation.pluginId,
        scopeId: buildPluginSandboxScopeId(latest.current.scope.scope),
        ...(detail?.error ? { error: detail.error } : {}),
      });
      if (next === "error") {
        void getPage().suspend(true);
        patch({ phase: "error", error: detail?.error ?? "MCP App failed" });
        return;
      }
      setPhase(next);
      if (detail?.handle) {
        setHandle(detail.handle);
        // 资源声明的初始高度替代固定 240；仍受 min / max clamp。
        const hint = detail.handle.resourceMeta?.heightHint;
        if (hint !== undefined) setHeight(clampCardHeight(hint, detail.handle));
        // 资源声明的浏览器权限随句柄到达（早于端口），进 hostContext 让页面 feature detect（规范草案 `permissions`）。
        const permissions = detail.handle.resourceMeta?.permissions;
        if (permissions?.length) {
          nextController.updateHostContext({
            permissions: Object.fromEntries(permissions.map((item) => [item, {}])),
          });
        }
      }
      if (detail?.error) setError(detail.error);
    },
    onInstanceClosed: () => {
      void getPage().suspend(true);
      clearPluginUiWidgetState(key);
      patch({ phase: "error", error: "MCP App connection is no longer available" });
    },
    onActivity: () => {
      if (getController() === nextController) pluginUiPages.activity(getPage());
    },
    onBusyChange: () => {
      if (getController() === nextController) pluginUiPages.settled(getPage());
    },
    onAppCapabilities: setAppCapabilities,
    onHeight: (next) => setHeight(clampCardHeight(next, getSnapshot().handle)),
    onDisplayModeRequest: (mode) => latest.current.onDisplayModeRequest?.(mode) ?? mode,
    onOpenExternal: (url) => latest.current.onOpenExternal?.(url),
    log: (message, detail) => logger.warn(message, detail),
  });

  return nextController;
}

function clampCardHeight(next: number, handle: PluginSandboxHandle | null): number {
  const min = Math.max(PLUGIN_UI_CARD_MIN_HEIGHT_PX, handle?.resourceMeta?.minFrameHeight ?? 0);
  return Math.min(PLUGIN_UI_CARD_MAX_HEIGHT_PX, Math.max(min, next));
}
