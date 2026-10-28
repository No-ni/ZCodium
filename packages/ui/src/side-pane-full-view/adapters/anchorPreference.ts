import type { FloatingAnchor } from "../contract.js";
import { DEFAULT_FLOATING_ANCHOR, parseFloatingAnchor } from "../domain/model.js";
import { logger } from "@/logger.js";

const STORAGE_KEY = "zcodium:side-pane-full-view:floating-anchor";
export function readFloatingAnchorPreference(): FloatingAnchor {
  try {
    return parseFloatingAnchor(window.localStorage.getItem(STORAGE_KEY)) ?? DEFAULT_FLOATING_ANCHOR;
  } catch {
    return DEFAULT_FLOATING_ANCHOR;
  }
}
export function writeFloatingAnchorPreference(anchor: FloatingAnchor): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, anchor);
  } catch {
    logger.warn("[SidePaneFullView] 浮窗吸附偏好写入失败");
  }
}
