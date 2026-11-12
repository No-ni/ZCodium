import { app, Menu, Tray, nativeImage } from "electron";
import { blendBadgeIntoBitmap, renderTrayStatusDotPixels } from "./unreadBadgePixels.js";
import { join } from "node:path";
import {
  DesktopCommandIds,
  desktopMenuMessageIds,
  getDesktopMenuMessage,
  shouldEnableDesktopAutoUpdates,
  type DesktopCommandId,
  type Locale,
} from "@zcode/shared";

let desktopTray: Tray | null = null;
let rebuildDesktopTrayContextMenu: (() => void) | null = null;
let unreadCount = 0;
let trayBaseImage: ReturnType<typeof nativeImage.createFromPath> | undefined;
let trayUnreadImage: ReturnType<typeof nativeImage.createFromPath> | undefined;

function trayImage(hasUnread: boolean) {
  const base = (trayBaseImage ??= nativeImage.createFromPath(resolveDesktopTrayIconPath()));
  // 原因：缺失 ICO 返回空图；用 0 字节构造 32×32 位图会弹出原生异常框并阻塞 Main。
  if (!hasUnread || base.isEmpty()) return base;
  if (trayUnreadImage) return trayUnreadImage;
  const size = 32;
  const badgeSize = 10;
  const resized = base.resize({ width: size, height: size });
  const dimensions = resized.getSize(1);
  if (resized.isEmpty() || dimensions.width !== size || dimensions.height !== size) return base;
  const bitmap = resized.toBitmap({ scaleFactor: 1 });
  // 原因：仅 2x 的 NativeImage 可返回更大的物理位图，显式 scaleFactor 也不能代替字节校验。
  if (bitmap.byteLength !== size * size * 4) return base;
  blendBadgeIntoBitmap({
    base: bitmap,
    size,
    badge: renderTrayStatusDotPixels(badgeSize),
    badgeSize,
    originX: size - badgeSize,
    originY: size - badgeSize,
  });
  return (trayUnreadImage ??= nativeImage.createFromBitmap(bitmap, {
    width: size,
    height: size,
    scaleFactor: 1,
  }));
}

export function syncWindowsDesktopTrayUnread(count: number) {
  unreadCount = Number.isSafeInteger(count) && count > 0 ? count : 0;
  if (process.platform !== "win32" || !desktopTray || desktopTray.isDestroyed()) return;
  desktopTray.setImage(trayImage(unreadCount > 0));
  rebuildDesktopTrayContextMenu?.();
}

function resolveDesktopTrayIconPath() {
  return app.isPackaged
    ? join(process.resourcesPath, "tray_icon.ico")
    : join(import.meta.dirname, "../../build/icon.ico");
}

export function createWindowsDesktopTray(options: {
  getLocale: () => Locale;
  showCurrentWindow: () => Promise<void> | void;
  executeDesktopCommand: (command: DesktopCommandId) => Promise<unknown>;
  quitApp: () => void;
  logger: { warn: (...args: unknown[]) => void };
}) {
  if (process.platform !== "win32") {
    return null;
  }

  if (desktopTray && !desktopTray.isDestroyed()) {
    return desktopTray;
  }
  desktopTray = null;

  try {
    desktopTray = new Tray(trayImage(unreadCount > 0));
  } catch (error) {
    options.logger.warn("[desktop-tray] failed to create tray icon", error);
    return null;
  }

  const getLabel = (id: (typeof desktopMenuMessageIds)[keyof typeof desktopMenuMessageIds]) =>
    getDesktopMenuMessage(options.getLocale(), id);
  const showTrayWindow = () => {
    void Promise.resolve(options.showCurrentWindow()).catch((error) => {
      options.logger.warn("[desktop-tray] failed to show current window", error);
    });
  };
  const executeTrayCommand = (command: DesktopCommandId) => {
    void Promise.resolve(options.showCurrentWindow())
      .then(() => options.executeDesktopCommand(command))
      .catch((error) => {
        options.logger.warn(`[desktop-tray] failed to execute tray command ${command}`, error);
      });
  };
  const rebuildContextMenu = () => {
    const tooltip = getLabel(desktopMenuMessageIds.trayTooltip);
    desktopTray?.setToolTip(
      unreadCount > 0
        ? `${tooltip} (${unreadCount} ${options.getLocale() === "zh-CN" ? "个未读任务" : "unread tasks"})`
        : tooltip,
    );
    desktopTray?.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: getLabel(desktopMenuMessageIds.trayOpenZCode),
          click: showTrayWindow,
        },
        { type: "separator" },
        {
          label: getLabel(desktopMenuMessageIds.fileNewTask),
          click: () => executeTrayCommand(DesktopCommandIds.NewTask),
        },
        {
          label: getLabel(desktopMenuMessageIds.fileOpenWorkspace),
          click: () => executeTrayCommand(DesktopCommandIds.OpenWorkspace),
        },
        { type: "separator" },
        // 原因：正式版空更新源也会跳过更新器；托盘必须跟随同一可用性，避免显示无效入口。
        ...(shouldEnableDesktopAutoUpdates()
          ? [
              {
                label: getLabel(desktopMenuMessageIds.helpCheckForUpdates),
                click: () => executeTrayCommand(DesktopCommandIds.CheckForUpdates),
              },
            ]
          : []),
        {
          label: getLabel(desktopMenuMessageIds.helpAbout),
          click: () => executeTrayCommand(DesktopCommandIds.ShowAbout),
        },
        {
          label: getLabel(desktopMenuMessageIds.helpClearAllData),
          click: () => executeTrayCommand(DesktopCommandIds.ClearAllData),
        },
        { type: "separator" },
        {
          label: getLabel(desktopMenuMessageIds.trayQuit),
          click: () => options.quitApp(),
        },
      ]),
    );
  };

  rebuildDesktopTrayContextMenu = rebuildContextMenu;
  desktopTray.on("click", showTrayWindow);
  desktopTray.on("double-click", showTrayWindow);
  rebuildContextMenu();

  return desktopTray;
}

export function updateWindowsDesktopTrayMenu() {
  rebuildDesktopTrayContextMenu?.();
}
