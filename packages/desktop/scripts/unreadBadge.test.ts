import assert from "node:assert/strict";
import test from "node:test";
import * as badge from "../src/main/unreadBadge.js";

const snapshot = (...taskKeys: string[]) => ({
  schemaVersion: 1 as const,
  count: taskKeys.length,
  taskKeys,
});

test("window unread projections deduplicate shared tasks without dropping distinct workspaces", () => {
  const counts = new Map<number, any>([
    [1, snapshot("source-a/task-a", "source-a/task-b")],
    [2, snapshot("source-a/task-a", "source-b/task-c")],
  ]);
  assert.equal(badge.sumWindowUnreadCounts(counts), 3);
});

test("empty windows and malformed snapshots cannot keep a stale badge", () => {
  assert.equal(
    badge.parseWindowUnreadCount({ schemaVersion: 1, count: 2, taskKeys: ["one"] }),
    null,
  );
  assert.equal(badge.parseWindowUnreadCount(-1), null);
  assert.equal(badge.parseWindowUnreadCount(0), 0);
  assert.equal(badge.sumWindowUnreadCounts(new Map()), 0);
});

test("Windows overlay only receives valid labels and zero clears it", () => {
  assert.equal((badge as any).resolveBadgeOverlayLabel(0), null);
  assert.equal((badge as any).resolveBadgeOverlayLabel(10), "9+");
  const calls: any[] = [];
  (badge as any).syncUnreadBadgeForPlatform({
    platform: "win32",
    totalUnreadCount: 3,
    setBadgeCount: () => assert.fail("Windows application badge is not an overlay"),
    applyOverlay: (label: unknown) => calls.push(label),
  });
  (badge as any).syncUnreadBadgeForPlatform({
    platform: "win32",
    totalUnreadCount: 0,
    setBadgeCount: () => {},
    applyOverlay: (label: unknown) => calls.push(label),
  });
  assert.deepEqual(calls, ["3", null]);
});

test("overlay rendering is bounded, transparent outside and skips destroyed windows", () => {
  const pixels = (badge as any).renderTaskbarStatusDotPixels(2);
  assert.equal(pixels.length, 32 * 32 * 4);
  assert.equal(pixels[3], 0);
  assert.ok(pixels.some((value: number) => value > 0));
  const calls: any[] = [];
  (badge as any).applyTaskbarOverlayToWindows({
    label: null,
    badgeImageForLabel: () => assert.fail("zero must not allocate"),
    windows: [
      { isDestroyed: () => true, setOverlayIcon: () => assert.fail("destroyed") },
      { isDestroyed: () => false, setOverlayIcon: (...args: any[]) => calls.push(args) },
    ],
  });
  assert.deepEqual(calls, [[null, ""]]);
});
