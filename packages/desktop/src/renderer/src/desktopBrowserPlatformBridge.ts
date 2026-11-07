import type { IPlatformService } from "@zcode/shared";

type DesktopBrowserPlatformBridge = Pick<
  IPlatformService,
  | "onBrowserViewDownloadStarted"
  | "onBrowserViewReady"
  | "onBrowserViewOperation"
  | "onBrowserViewViewportChanged"
  | "onBrowserViewVisibility"
  | "onBrowserViewCloseTab"
  | "onBrowserViewSuspend"
  | "onBrowserViewRestore"
  | "browserViewAttachGuest"
  | "browserViewDetachGuest"
  | "browserViewCloseTab"
  | "browserViewReportResidency"
  | "browserViewSuspendReady"
  | "browserViewEnsureResident"
  | "browserViewRestoreTabs"
  | "browserViewUpdateViewport"
  | "importChromeBrowserData"
  | "clearEmbeddedBrowserData"
  | "getEmbeddedBrowserSitePermissions"
  | "setEmbeddedBrowserSitePermission"
  | "clearEmbeddedBrowserSitePermissions"
  | "resetEmbeddedBrowserSitePermission"
  | "onEmbeddedBrowserPermissionPrompt"
  | "resolveEmbeddedBrowserPermissionPrompt"
  | "getPathForFile"
  | "saveFile"
  | "printPageToPdf"
>;

// Rebase 集成：browser bridge 若继续内联在 renderer 入口，会让入口越过 max-lines 门禁。
// 独立对象只做 preload 委托与旧 bridge 兼容兜底，不持有 Browser 业务状态。
export const desktopBrowserPlatformBridge = {
  // BUG-005：Main 已安装权限策略，但平台漏委托会使设置页判为不支持、气泡无法订阅。
  // 只补既有 preload 能力；旧 preload 缺方法时保持 undefined，不能伪造授权快照或成功。
  getEmbeddedBrowserSitePermissions: window.zcode.getEmbeddedBrowserSitePermissions
    ? () => window.zcode.getEmbeddedBrowserSitePermissions!()
    : undefined,
  setEmbeddedBrowserSitePermission: window.zcode.setEmbeddedBrowserSitePermission
    ? (request) => window.zcode.setEmbeddedBrowserSitePermission!(request)
    : undefined,
  clearEmbeddedBrowserSitePermissions: window.zcode.clearEmbeddedBrowserSitePermissions
    ? () => window.zcode.clearEmbeddedBrowserSitePermissions!()
    : undefined,
  resetEmbeddedBrowserSitePermission: window.zcode.resetEmbeddedBrowserSitePermission
    ? (request) => window.zcode.resetEmbeddedBrowserSitePermission!(request)
    : undefined,
  onEmbeddedBrowserPermissionPrompt: window.zcode.onEmbeddedBrowserPermissionPrompt
    ? (handler) => window.zcode.onEmbeddedBrowserPermissionPrompt!(handler)
    : undefined,
  resolveEmbeddedBrowserPermissionPrompt: window.zcode.resolveEmbeddedBrowserPermissionPrompt
    ? (request) => window.zcode.resolveEmbeddedBrowserPermissionPrompt!(request)
    : undefined,
  getPathForFile: (file) => window.zcode.getPathForFile?.(file) ?? null,
  saveFile: (payload) =>
    window.zcode.saveFile?.(payload) ?? Promise.resolve({ success: false, error: "not_supported" }),
  // 条件定义而非兜底返回失败：UI 靠方法是否存在做能力检测，旧 preload 下必须保持 undefined
  printPageToPdf: window.zcode.printPageToPdf ? () => window.zcode.printPageToPdf!() : undefined,
  onBrowserViewDownloadStarted: (handler) =>
    window.zcode.onBrowserViewDownloadStarted?.(handler) ?? (() => {}),
  onBrowserViewReady: (handler) => window.zcode.onBrowserViewReady?.(handler) ?? (() => {}),
  onBrowserViewOperation: (handler) => window.zcode.onBrowserViewOperation?.(handler) ?? (() => {}),
  onBrowserViewViewportChanged: (handler) =>
    window.zcode.onBrowserViewViewportChanged?.(handler) ?? (() => {}),
  onBrowserViewVisibility: (handler) =>
    window.zcode.onBrowserViewVisibility?.(handler) ?? (() => {}),
  onBrowserViewCloseTab: (handler) => window.zcode.onBrowserViewCloseTab?.(handler) ?? (() => {}),
  onBrowserViewSuspend: (handler) => window.zcode.onBrowserViewSuspend?.(handler) ?? (() => {}),
  onBrowserViewRestore: (handler) => window.zcode.onBrowserViewRestore?.(handler) ?? (() => {}),
  browserViewAttachGuest: (payload) =>
    window.zcode.browserViewAttachGuest?.(payload) ??
    Promise.resolve({ ok: false, reason: "not-found", recoveryRequested: false }),
  browserViewDetachGuest: (payload) =>
    window.zcode.browserViewDetachGuest?.(payload) ?? Promise.resolve(false),
  browserViewCloseTab: (payload) =>
    window.zcode.browserViewCloseTab?.(payload) ?? Promise.resolve(),
  browserViewReportResidency: (payload) =>
    window.zcode.browserViewReportResidency?.(payload) ?? Promise.resolve(),
  browserViewSuspendReady: (payload) =>
    window.zcode.browserViewSuspendReady?.(payload) ?? Promise.resolve(),
  browserViewEnsureResident: (payload) =>
    window.zcode.browserViewEnsureResident?.(payload) ?? Promise.resolve(),
  browserViewRestoreTabs: (payload) =>
    window.zcode.browserViewRestoreTabs?.(payload) ?? Promise.resolve([]),
  browserViewUpdateViewport: (payload) =>
    window.zcode.browserViewUpdateViewport?.(payload) ?? Promise.resolve(),
  importChromeBrowserData: (options) =>
    window.zcode.importChromeBrowserData?.(options) ??
    Promise.resolve({
      success: false,
      cookies: { imported: 0, skipped: 0, failed: 0 },
      localStorage: {
        originsImported: 0,
        entriesImported: 0,
        originsSkipped: 0,
        originsFailed: 0,
      },
      error: "unsupported",
    }),
  clearEmbeddedBrowserData: (mode) =>
    window.zcode.clearEmbeddedBrowserData?.(mode) ??
    Promise.resolve({ success: false, error: "unsupported" }),
} satisfies DesktopBrowserPlatformBridge;
