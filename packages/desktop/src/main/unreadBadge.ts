import { windowUnreadSnapshotSchema, type WindowUnreadProjection } from "@zcode/shared";
export { renderTaskbarStatusDotPixels, blendBadgeIntoBitmap } from "./unreadBadgePixels.js";

type AppBadgeSetter = (count: number) => void;

export function parseWindowUnreadProjection(payload: unknown): WindowUnreadProjection | null {
  if (typeof payload === "number")
    return Number.isSafeInteger(payload) && payload >= 0 ? payload : null;
  const result = windowUnreadSnapshotSchema.safeParse(payload);
  return result.success ? result.data : null;
}

export function parseWindowUnreadCount(payload: unknown): number | null {
  const parsed = parseWindowUnreadProjection(payload);
  return parsed === null ? null : typeof parsed === "number" ? parsed : parsed.count;
}

export function sumWindowUnreadCounts(
  projections: ReadonlyMap<number, WindowUnreadProjection>,
): number {
  const keys = new Set<string>();
  let legacyCount = 0;
  for (const projection of projections.values()) {
    if (typeof projection === "number") legacyCount += projection;
    else for (const key of projection.taskKeys) keys.add(key);
  }
  // 当前窗口并非同一全局树，不能取 max；严格身份投影去重，旧数值客户端保持原 sum 契约。
  return keys.size + legacyCount;
}

export function syncAppUnreadBadge(options: {
  platform: NodeJS.Platform;
  totalUnreadCount: number;
  setBadgeCount: AppBadgeSetter;
}): void {
  if (options.platform === "darwin" || options.platform === "linux")
    options.setBadgeCount(options.totalUnreadCount);
}

export function resolveBadgeOverlayLabel(count: number): string | null {
  return Number.isSafeInteger(count) && count > 0 ? (count > 9 ? "9+" : String(count)) : null;
}

export function syncUnreadBadgeForPlatform(options: {
  platform: NodeJS.Platform;
  totalUnreadCount: number;
  setBadgeCount: AppBadgeSetter;
  applyOverlay: (label: string | null) => void;
}): void {
  if (options.platform === "win32")
    options.applyOverlay(resolveBadgeOverlayLabel(options.totalUnreadCount));
  else syncAppUnreadBadge(options);
}

export interface TaskbarOverlayWindow {
  isDestroyed(): boolean;
  setOverlayIcon(image: unknown, description: string): void;
}

export function applyTaskbarOverlayToWindows(options: {
  label: string | null;
  windows: Iterable<TaskbarOverlayWindow>;
  badgeImageForLabel: (label: string) => unknown;
}): void {
  const image = options.label ? options.badgeImageForLabel(options.label) : null;
  for (const window of options.windows) {
    if (!window.isDestroyed())
      window.setOverlayIcon(image, options.label ? `${options.label} unread tasks` : "");
  }
}
