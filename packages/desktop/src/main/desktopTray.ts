import { app, Menu, Tray, nativeImage } from "electron";
import { blendBadgeIntoBitmap, renderTrayStatusDotPixels } from "./unreadBadgePixels.js";
import { join } from "node:path";
import {
  DesktopCommandIds,
  desktopMenuMessageIds,
  getDesktopMenuMessage,
  ZCODE_PRODUCT_FLAVOR,
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
  if (!hasUnread) return base;
  if (trayUnreadImage) return trayUnreadImage;
  const size = 32;
  const badgeSize = 10;
  const bitmap = base.resize({ width: size, height: size }).toBitmap();
  blendBadgeIntoBitmap({
    base: bitmap,
    size,
    badge: renderTrayStatusDotPixels(badgeSize),
    badgeSize,
    originX: size - badgeSize,
    originY: size - badgeSize,
  });
  return (trayUnreadImage ??= nativeImage.createFromBitmap(bitmap, { width: size, height: size }));
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
        // 更新入口跟随产品身份：Preview（含生产后端的 Preview）禁用更新器，托盘也不能露出入口。
        ...(ZCODE_PRODUCT_FLAVOR === "production"
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
