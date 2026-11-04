import {
  ZCODE_PRODUCT_FLAVOR,
  ZCODIUM_UPDATE_ORIGIN,
  shouldEnableDesktopAutoUpdates,
  type ZCodeProductFlavor,
  type UpdateStatePayload,
} from "@zcode/shared";

// 仅按身份判断会在空更新源时露出无功能入口；沿用 shared 的身份 + 自有源判定。
export function shouldShowDesktopUpdateEntry(
  flavor: ZCodeProductFlavor = ZCODE_PRODUCT_FLAVOR,
  updateOrigin: string = ZCODIUM_UPDATE_ORIGIN,
): boolean {
  return shouldEnableDesktopAutoUpdates(flavor, updateOrigin);
}

export function getUpdateMenuLabelId(state: UpdateStatePayload | null) {
  switch (state?.kind) {
    case "checking":
      return "desktopMenu.help.checkingForUpdates";
    case "update-available":
      return "desktopMenu.help.updateAvailableVersion";
    case "download-progress":
      return "desktopMenu.help.downloadingUpdateProgress";
    case "update-downloaded":
      return "desktopMenu.help.restartToUpdate";
    case "idle":
    default:
      return "titleBar.menu.help.checkForUpdates";
  }
}

export function getUpdateMenuLabelValues(
  state: UpdateStatePayload | null,
): Record<string, string> | undefined {
  switch (state?.kind) {
    case "update-available":
    case "update-downloaded":
      return { version: state.version };
    case "download-progress":
      return { progress: state.progress };
    default:
      return undefined;
  }
}
