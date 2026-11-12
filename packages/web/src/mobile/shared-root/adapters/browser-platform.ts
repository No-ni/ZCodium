import type { IPlatformService, WebRemoteControlPlatformMethod } from "@zcode/shared";
import {
  isBrowserClipboardAvailable,
  selectBrowserFileData,
  writeBrowserClipboardText,
} from "@zcode/ui";
import type { MobileRootWorkspaceAccess, MobileSharedRootTransport } from "../contract.js";

type PlatformMethodArgs<K extends WebRemoteControlPlatformMethod> =
  NonNullable<IPlatformService[K]> extends (...args: infer Args) => unknown ? Args : never;
type PlatformMethodResult<K extends WebRemoteControlPlatformMethod> =
  NonNullable<IPlatformService[K]> extends (...args: never[]) => infer Result
    ? Awaited<Result>
    : never;

function platformError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

/** 只适配当前手机浏览器与已配对 Host；会话和已接受输入仍由共享 Root/Runtime 持有。 */
export function createMobileBrowserPlatform(
  client: MobileSharedRootTransport,
  access: MobileRootWorkspaceAccess,
  saveFile: NonNullable<IPlatformService["saveFile"]>,
): IPlatformService {
  let requestSeq = 0;
  const assertCurrent = () => {
    if (!access.isCurrent()) throw platformError("mobile-workspace-superseded");
  };

  async function requestHost<K extends WebRemoteControlPlatformMethod>(
    method: K,
    ...args: PlatformMethodArgs<K>
  ): Promise<PlatformMethodResult<K>> {
    assertCurrent();
    const requestId = `mobile-platform-${access.generation}-${++requestSeq}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let response;
    try {
      response = await client.request({
        zcode_type: "platform-request",
        requestId,
        method,
        // 原因：undefined 在 JSON 信封中会丢字段；无参方法明确传 null，可选 MCP 参数由入口传空对象。
        args: args[0] ?? null,
      });
    } catch {
      assertCurrent();
      // Host/传输的原始错误可能包含路径或配置，只返回固定分类。
      throw platformError("mobile-platform-request-failed");
    }
    assertCurrent();
    if (
      response.zcode_type !== "platform-response" ||
      response.requestId !== requestId ||
      response.method !== method
    )
      throw platformError("mobile-platform-response-invalid");
    if (!response.success) throw platformError("mobile-platform-request-failed");
    if (response.result === undefined) throw platformError("mobile-platform-response-invalid");
    return response.result as PlatformMethodResult<K>;
  }

  async function browserAction<T>(action: () => Promise<T>): Promise<T> {
    assertCurrent();
    try {
      // Safari 的用户激活不能跨 await；公开 primitive 在当前点击栈立即启动。
      const result = await action();
      assertCurrent();
      return result;
    } catch (error) {
      assertCurrent();
      const failure = platformError("mobile-browser-action-failed");
      // 导入入口依赖已有的超限分类，保留 kind，不能透传浏览器原始消息。
      if (
        typeof error === "object" &&
        error !== null &&
        "kind" in error &&
        error.kind === "limit_exceeded"
      )
        throw Object.assign(failure, { kind: "limit_exceeded" });
      throw failure;
    }
  }

  const unsupported = () =>
    Promise.resolve({ success: false, error: "mobile-platform-unsupported" });
  const noSubscription = () => () => {};
  const noOperation = () => {};
  const noAsyncOperation = () => Promise.resolve();

  return {
    canSelectFilePath: false,
    canOpenLocalFiles: false,
    writeClipboardText: isBrowserClipboardAvailable()
      ? (text) => browserAction(() => writeBrowserClipboardText(text))
      : undefined,
    selectFileData: (options) => browserAction(() => selectBrowserFileData(options)),
    async saveFile(payload) {
      const result = await browserAction(() => saveFile(payload));
      if (result.canceled) return { success: false, canceled: true };
      return result.success ? result : { success: false, error: "mobile-browser-save-failed" };
    },
    selectDirectory: () => Promise.resolve(null),
    selectFile: () => Promise.resolve(null),
    selectFiles: () => Promise.resolve([]),
    getPathForFile: () => null,
    createTempTextAttachment: (payload) => requestHost("createTempTextAttachment", payload),
    async getSystemLocale() {
      // 显式 system 必须读取当前 Host，不能由手机 navigator 或旧设置值反写桌面语言。
      const locale = await requestHost("getSystemLocale");
      if (locale !== "zh-CN" && locale !== "en-US")
        throw platformError("mobile-platform-response-invalid");
      return locale;
    },
    isDockerAvailable: () => requestHost("isDockerAvailable"),
    listWSLDistros: () => requestHost("listWSLDistros"),
    listDockerContainers: () => requestHost("listDockerContainers"),
    listSSHConfigAliases: () => requestHost("listSSHConfigAliases"),
    loadMcpFromUserDirectory: (payload) => requestHost("loadMcpFromUserDirectory", payload ?? {}),
    async saveMcpToUserDirectory(payload) {
      const result = await requestHost("saveMcpToUserDirectory", payload);
      if (typeof result?.success !== "boolean")
        throw platformError("mobile-platform-response-invalid");
      return result.success
        ? { success: true }
        : { success: false, error: "mobile-platform-request-failed" };
    },
    migrateLegacyCommonMcp: (payload) => requestHost("migrateLegacyCommonMcp", payload ?? {}),
    onRemoteConnectionLog: noSubscription,
    onRemoteSessionClosed: noSubscription,
    onBotRemoteWorkspaceReconnected: noSubscription,
    activateOrSetWorkspace: () => Promise.resolve({ activated: false }),
    connectRemote: unsupported,
    cancelPendingRemoteConnection: noAsyncOperation,
    disposeRemoteSession: noAsyncOperation,
    startWebRemoteControl: () => Promise.reject(platformError("mobile-platform-unsupported")),
    stopWebRemoteControl: noAsyncOperation,
    getWebRemoteControlStatus: () => Promise.resolve({ status: "idle" as const }),
    refreshWebRemoteControlPairing: () =>
      Promise.reject(platformError("mobile-platform-unsupported")),
    syncWebRemoteControlWorkspaces: noAsyncOperation,
    syncWebRemoteControlTasks: noAsyncOperation,
    onWebRemoteControlStatusChanged: noSubscription,
    onWebRemoteControlReconnectWorkspace: noSubscription,
    openExternal: (url) => {
      if (access.isCurrent()) window.open(url, "_blank", "noopener,noreferrer");
    },
    openFeedback: noAsyncOperation,
    openCommunity: noAsyncOperation,
    canOpenCommunity: () => Promise.resolve(false),
    openInFileManager: unsupported,
    openExternalFile: unsupported,
    notifyRendererReady: noOperation,
    showTaskNotification: noOperation,
    syncWindowTabs: noOperation,
    syncWindowUnreadCount: noOperation,
    syncActiveTaskSession: noOperation,
    onFocusTab: noSubscription,
    onNewTab: noSubscription,
    onCloseActiveContextRequest: noSubscription,
    onOpenBrowserUrl: noSubscription,
    onNewTask: noSubscription,
    onOpenWorkspace: noSubscription,
    onWindowFullscreenChanged: noSubscription,
    onTaskNotificationClick: noSubscription,
    exportLogs: unsupported,
    onUpdateReady: noSubscription,
    onUpdateCheckResult: noSubscription,
    onPostUpdateReleaseNotes: noSubscription,
    downloadUpdate: noAsyncOperation,
    cancelUpdateDownload: noAsyncOperation,
    acknowledgePostUpdateReleaseNotes: noAsyncOperation,
    skipUpdateVersion: noAsyncOperation,
    quitAndInstallUpdate: noAsyncOperation,
    getInstalledEditors: () => Promise.resolve([]),
    openInEditor: unsupported,
    executeDesktopCommand: noAsyncOperation,
    setApplicationLocale: noAsyncOperation,
    setTitleBarTheme: noAsyncOperation,
  };
}
