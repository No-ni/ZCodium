import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { obtainUnreadPairingUrl } from "../web-remote-unread.js";
import { withNativeContextCleanup } from "./cleanup.js";
import { assertNativeContextTestPath } from "./environment.js";

function readNativeContextDesktopPairingSurface() {
  // 原因：第四轮入口仍在 DOM，但 isPainted=false；同一选择器必须先证明实际可见和中心命中。
  const entries = document.querySelectorAll<HTMLButtonElement>(
    'button[aria-label="移动端远程控制"], button[aria-label="Mobile remote control"]',
  );
  const entry = entries[0] ?? null;
  const panel =
    entry?.closest<HTMLElement>('[data-workspace-sidebar-panel="true"]') ??
    document.querySelector<HTMLElement>('[data-workspace-sidebar-panel="true"]');
  const aside = panel?.querySelector("aside");
  const hidden = aside?.getAttribute("aria-hidden");
  const toggle = document.querySelector<HTMLButtonElement>(
    '[data-testid="desktop-top-logo-sidebar-toggle"]',
  );
  const painted = (node: Element | null | undefined) => {
    const rect = node?.getBoundingClientRect();
    if (!node || !rect || rect.width <= 0 || rect.height <= 0) return false;
    for (let current: Element | null = node; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        style.opacity === "0"
      )
        return false;
    }
    return true;
  };
  const target = (node: Element | null) => {
    const rect = node?.getBoundingClientRect();
    const x = rect ? rect.x + rect.width / 2 : -1;
    const y = rect ? rect.y + rect.height / 2 : -1;
    const hit =
      x >= 0 && x < innerWidth && y >= 0 && y < innerHeight
        ? document.elementFromPoint(x, y)
        : null;
    return {
      present: Boolean(node),
      painted: painted(node),
      disabled: node?.matches(":disabled") ?? false,
      centerHit: Boolean(node && hit && (node === hit || node.contains(hit))),
      hitIsDialog: Boolean(hit?.closest('[role="dialog"]')),
      hitTag: hit
        ? ["DIV", "BUTTON", "SVG", "PATH"].includes(hit.tagName)
          ? hit.tagName
          : "OTHER"
        : null,
      rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
    };
  };
  const animationPending = [panel, toggle].some((node) =>
    node?.getAnimations({ subtree: true }).some((animation) => {
      const timing = animation.effect?.getComputedTiming();
      return (
        (animation.pending || animation.playState === "running") && timing?.iterations !== Infinity
      );
    }),
  );
  return {
    viewport: { width: innerWidth, height: innerHeight },
    panel: {
      present: Boolean(panel && aside),
      ariaHidden: hidden === "true" ? true : hidden === "false" ? false : null,
      painted: painted(panel),
    },
    entry: {
      ...target(entry),
      candidates: entries.length,
      inPanel: Boolean(entry && panel?.contains(entry)),
    },
    toggle: target(toggle),
    animationPending,
    pairingDialogPresent: painted(
      document.querySelector('[data-testid="web-remote-control-dialog-scroll"]'),
    ),
  };
}

/** 只存结构和数字，不记录配对 URL、proof、路径、正文或原始异常。 */
async function recordNativeContextDesktopPairingSurface(diagnostics: string, stage: string) {
  const surface = await browser.execute(readNativeContextDesktopPairingSurface);
  const path = await assertNativeContextTestPath(
    join(diagnostics, "desktop-pairing-admission.jsonl"),
  );
  await appendFile(path, JSON.stringify({ stage, surface }) + "\n");
  return surface;
}

export async function obtainNativeContextPairingUrl(expectedOrigin: string, diagnostics: string) {
  let openedSidebar = false;
  let pairingStarted = false;
  const wait = async (
    check: (surface: ReturnType<typeof readNativeContextDesktopPairingSurface>) => boolean,
    timeoutMsg: string,
  ) =>
    browser.waitUntil(
      async () => check(await browser.execute(readNativeContextDesktopPairingSurface)),
      {
        timeout: 20000,
        interval: 100,
        timeoutMsg,
      },
    );
  return withNativeContextCleanup(
    async () => {
      try {
        const initial = await recordNativeContextDesktopPairingSurface(diagnostics, "before");
        assert.ok(initial.panel.present && initial.panel.ariaHidden !== null);
        if (initial.panel.ariaHidden) {
          await wait(
            (surface) =>
              surface.toggle.painted &&
              surface.toggle.centerHit &&
              !surface.toggle.disabled &&
              !surface.animationPending,
            "NCTX the real desktop sidebar toggle is not ready for pairing",
          );
          await $('[data-testid="desktop-top-logo-sidebar-toggle"]').click();
          openedSidebar = true;
        }
        await wait(
          (surface) =>
            surface.panel.ariaHidden === false &&
            surface.panel.painted &&
            surface.entry.inPanel &&
            surface.entry.painted &&
            surface.entry.centerHit &&
            !surface.entry.disabled &&
            !surface.animationPending,
          "NCTX the real desktop pairing entry is not painted and hit-testable",
        );
        await recordNativeContextDesktopPairingSurface(diagnostics, "ready");
        pairingStarted = true;
        return await obtainUnreadPairingUrl(expectedOrigin);
      } catch (error) {
        try {
          await recordNativeContextDesktopPairingSurface(diagnostics, "pairing-failed");
        } catch (captureError) {
          throw new AggregateError([error, captureError], "NCTX pairing and evidence both failed");
        }
        throw error;
      }
    },
    async () => {
      try {
        const current = await browser.execute(readNativeContextDesktopPairingSurface);
        if (pairingStarted && current.pairingDialogPresent) await browser.keys("Escape");
        if (!openedSidebar) return;
        assert.ok(current.panel.present && current.panel.ariaHidden !== null);
        if (current.panel.ariaHidden === false) {
          await wait(
            (surface) =>
              surface.toggle.painted &&
              surface.toggle.centerHit &&
              !surface.toggle.disabled &&
              !surface.animationPending,
            "NCTX the real desktop sidebar toggle is unavailable for restoration",
          );
          await $('[data-testid="desktop-top-logo-sidebar-toggle"]').click();
        }
        await wait(
          (surface) =>
            surface.panel.ariaHidden === true &&
            !surface.panel.painted &&
            !surface.animationPending,
          "NCTX the original collapsed sidebar did not restore after pairing",
        );
        await recordNativeContextDesktopPairingSurface(diagnostics, "restored");
      } catch (error) {
        try {
          await recordNativeContextDesktopPairingSurface(diagnostics, "restore-failed");
        } catch (captureError) {
          throw new AggregateError(
            [error, captureError],
            "NCTX restoration and evidence both failed",
          );
        }
        throw error;
      }
    },
  );
}
