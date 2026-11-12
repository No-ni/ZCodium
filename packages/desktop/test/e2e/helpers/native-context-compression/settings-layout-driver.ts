import { join } from "node:path";
import type { Page } from "playwright-core";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_TASK_ITEM,
  TID_TASK_SETTINGS_BUTTON,
  TID_V4_SESSION_PANE,
  testId,
} from "@zcode/shared/test-ids";
import {
  restoreElectronRendererContentSize,
  setCurrentElectronRendererContentSize,
} from "../desktop-app.js";
import { showMobileTaskHome } from "../web-remote-unread.js";
import { runNativeContextCleanup } from "./cleanup.js";
import { assertNativeContextTestPath } from "./environment.js";
import {
  assertNativeContextMobileParameterLayout,
  assertNativeContextParameterLayout,
} from "./parameter-layout.js";

export const settingsTestSelector = (id: string) => `[data-testid="${id}"]`;

function readSettingsUi(surface: string) {
  const root = document.documentElement;
  const element = surface ? document.querySelector<HTMLElement>(surface) : null;
  const dialog = element?.closest<HTMLElement>('[role="dialog"]');
  const scroll = dialog?.querySelector<HTMLElement>(
    '[data-testid="native-context-parameter-scroll"], [data-testid="native-context-detail-scroll"]',
  );
  const rect = dialog?.getBoundingClientRect();
  const tablist = dialog?.querySelector('[role="tablist"]');
  const detailScroll = dialog?.querySelector('[data-testid="native-context-detail-scroll"]');
  const tabs = Array.from(dialog?.querySelectorAll('[role="tab"]') ?? []);
  // 原因：命名 bounds 被测试转译器包装为模块 __name，独立页面快照必须没有该闭包依赖。
  const bounds = [tablist, ...tabs, detailScroll].map((target) => {
    if (!target) return null;
    const box = target.getBoundingClientRect();
    return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, height: box.height };
  });
  return {
    width: innerWidth,
    height: innerHeight,
    taskId:
      document
        .querySelector('[data-testid="v4-session-pane-workspace-main"]')
        ?.getAttribute("data-session-id") ?? null,
    lastSection: localStorage.getItem("zcode-settings-last-section"),
    themePreference: localStorage.getItem("zcode-theme"),
    localePreference: localStorage.getItem("zcode-locale-preference"),
    dark: root.classList.contains("dark"),
    lightClass: root.classList.contains("theme-zai-light"),
    darkClass: root.classList.contains("theme-zai-dark"),
    systemDark: matchMedia("(prefers-color-scheme: dark)").matches,
    browserThemeSurface: root.getAttribute("data-zcode-browser-theme-surface"),
    colorScheme: root.style.colorScheme,
    themeColor: document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content,
    backgroundToken: getComputedStyle(root).getPropertyValue("--color-background").trim(),
    surface: dialog
      ? {
          title: dialog.querySelector('[data-slot="dialog-title"]')?.textContent?.trim() ?? "",
          text: element?.innerText ?? "",
          tabs: Array.from(dialog.querySelectorAll('[role="tab"]')).map(
            (tab) => tab.textContent?.trim() ?? "",
          ),
          tablist: bounds[0] ?? null,
          tabButtons: bounds.slice(1, 1 + tabs.length).filter((box) => box !== null),
          detailScroll: bounds.at(-1) ?? null,
          background: getComputedStyle(dialog).backgroundColor,
          foreground: getComputedStyle(dialog).color,
          x: rect!.x,
          right: rect!.right,
          bottom: rect!.bottom,
          scrollWidth: scroll?.scrollWidth ?? 0,
          clientWidth: scroll?.clientWidth ?? 0,
        }
      : null,
  };
}

function readSettingsOptions() {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).map((option) => ({
    label: option.textContent?.trim() ?? "",
    testId: option.dataset.testid ?? "",
    selected: option.getAttribute("data-state") === "checked",
  }));
}

function settingsUiSettled(size: { width: number; height: number }) {
  return (
    innerWidth === size.width &&
    innerHeight === size.height &&
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.playState !== "running" ||
          animation.effect?.getComputedTiming().iterations === Infinity,
      )
  );
}

function scrollSettingsTarget({ selector, index }: { selector: string; index: number }) {
  const element = document.querySelectorAll(selector)[index];
  if (!element) throw new Error("NCTX settings interaction target is missing");
  element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
}

function settingsTargetIsHit({ selector, index }: { selector: string; index: number }) {
  const element = document.querySelectorAll(selector)[index];
  const rect = element?.getBoundingClientRect();
  if (!element || !rect || rect.width <= 0 || rect.height <= 0) return false;
  const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
  return hit !== null && (hit === element || element.contains(hit));
}

export interface NativeSettingsLayoutDriver {
  mobile: boolean;
  snapshot(surface?: string): Promise<ReturnType<typeof readSettingsUi>>;
  options(): Promise<ReturnType<typeof readSettingsOptions>>;
  visible(selector: string): Promise<boolean>;
  wait(check: () => Promise<boolean>, message: string): Promise<void>;
  scroll(selector: string, index?: number): Promise<void>;
  click(selector: string, index?: number): Promise<void>;
  pressEscape(): Promise<void>;
  resize(width: number): Promise<void>;
  parameterLayout(width: number): Promise<void>;
  screenshot(path: string): Promise<void>;
  openSettings(): Promise<void>;
  returnTask(taskId: string): Promise<void>;
  restoreViewport(): Promise<void>;
}

export async function closeNativeSettingsDialogs(driver: NativeSettingsLayoutDriver) {
  if (await driver.visible('[role="option"]')) {
    await driver.pressEscape();
    await driver.wait(
      async () => !(await driver.visible('[role="option"]')),
      "NCTX open options did not close",
    );
  }
  for (const id of ["native-context-defaults-dialog", "native-context-details"]) {
    const selector = settingsTestSelector(id);
    if (await driver.visible(selector)) {
      await driver.click(`${selector} [data-slot="dialog-close"]`);
      await driver.wait(
        async () => !(await driver.visible(selector)),
        "NCTX native dialog did not close",
      );
    }
  }
  if (await driver.visible(settingsTestSelector("native-context-popover")))
    await driver.pressEscape();
}

/** 失败现场在清理偏好和导航前保存；截图失败也不能掩盖首次断言。 */
export async function withNativeSettingsEvidence(
  driver: NativeSettingsLayoutDriver,
  evidenceDirectory: string,
  action: () => Promise<void>,
) {
  try {
    await action();
  } catch (error) {
    try {
      await driver.screenshot(
        join(
          evidenceDirectory,
          `native-settings-${driver.mobile ? "mobile" : "desktop"}-failure.png`,
        ),
      );
    } catch (captureError) {
      throw new AggregateError(
        [error, captureError],
        "NCTX settings assertion and screenshot failed",
      );
    }
    throw error;
  }
}

function attachSettingsNavigation(
  base: Omit<NativeSettingsLayoutDriver, "openSettings" | "returnTask">,
  home: () => Promise<void>,
): NativeSettingsLayoutDriver {
  const driver: NativeSettingsLayoutDriver = {
    ...base,
    async openSettings() {
      if (!(await base.visible(settingsTestSelector(TID_SETTINGS_PAGE)))) {
        await home();
        await base.click(settingsTestSelector(TID_TASK_SETTINGS_BUTTON));
      }
      await base.wait(
        () => base.visible(settingsTestSelector(TID_SETTINGS_PAGE)),
        "NCTX the real settings page did not open",
      );
    },
    async returnTask(taskId) {
      if (await base.visible(settingsTestSelector(TID_SETTINGS_PAGE))) {
        await base.click(settingsTestSelector(TID_SETTINGS_BACK_BUTTON));
        await base.wait(
          async () => !(await base.visible(settingsTestSelector(TID_SETTINGS_PAGE))),
          "NCTX settings did not return to the original workspace",
        );
      }
      const pane = settingsTestSelector(testId(TID_V4_SESSION_PANE, "workspace-main"));
      if (base.mobile && !(await base.visible(pane)))
        await base.click(settingsTestSelector(testId(TID_TASK_ITEM, taskId)));
      await base.wait(
        async () => (await base.visible(pane)) && (await base.snapshot()).taskId === taskId,
        "NCTX settings navigation did not return to the original task",
      );
    },
  };
  return driver;
}

const wait = async (check: () => Promise<boolean>, timeoutMsg: string) => {
  await browser.waitUntil(check, { timeout: 20000, interval: 100, timeoutMsg });
};

export async function createNativeDesktopSettingsDriver(): Promise<NativeSettingsLayoutDriver> {
  const initial = await browser.execute(readSettingsUi, "");
  const sidebarWasVisible = await $(settingsTestSelector(TID_TASK_SETTINGS_BUTTON)).isDisplayed();
  const original = await setCurrentElectronRendererContentSize(1024, 850);
  const minimum = await browser.electron.execute((electron, id) => {
    const window = electron.BrowserWindow.fromId(id)!;
    const previous = window.getMinimumSize();
    window.setMinimumSize(320, 400);
    return previous;
  }, original.windowId);
  const scroll = async (selector: string, index = 0) => {
    await wait(async () => {
      const element = (await $$(selector))[index];
      return element !== undefined && (await element.isDisplayed());
    }, "NCTX settings interaction target did not appear");
    await browser.execute(scrollSettingsTarget, { selector, index });
    const size = await browser.execute(() => ({ width: innerWidth, height: innerHeight }));
    await wait(() => browser.execute(settingsUiSettled, size), "NCTX settings UI is still moving");
  };
  const click = async (selector: string, index = 0) => {
    await scroll(selector, index);
    // 原因：直接 JS click 会绕过首轮真实的裁切/遮挡；先核对命中点，再发真实鼠标输入。
    expect(await browser.execute(settingsTargetIsHit, { selector, index })).toBe(true);
    const element = (await $$(selector))[index];
    if (!element) throw new Error("NCTX settings click target is missing");
    await element.click();
  };
  return attachSettingsNavigation(
    {
      mobile: false,
      snapshot: (surface = "") => browser.execute(readSettingsUi, surface),
      options: () => browser.execute(readSettingsOptions),
      visible: (selector) => $(selector).isDisplayed(),
      wait,
      scroll,
      click,
      pressEscape: async () => {
        await browser.keys("Escape");
      },
      resize: async (width) => {
        await setCurrentElectronRendererContentSize(width, 850);
        await wait(
          () => browser.execute(settingsUiSettled, { width, height: 850 }),
          "NCTX settings viewport did not settle",
        );
      },
      parameterLayout: (width) => assertNativeContextParameterLayout(width, "defaults"),
      screenshot: async (path) => {
        await browser.saveScreenshot(await assertNativeContextTestPath(path));
      },
      restoreViewport: async () => {
        await runNativeContextCleanup(
          async () => {
            const sidebarVisible = await $(
              settingsTestSelector(TID_TASK_SETTINGS_BUTTON),
            ).isDisplayed();
            if (sidebarVisible !== sidebarWasVisible)
              await click(settingsTestSelector("desktop-top-logo-sidebar-toggle"));
          },
          async () => {
            await browser.electron.execute(
              (electron, id, size) => {
                electron.BrowserWindow.fromId(id)?.setMinimumSize(size[0]!, size[1]!);
              },
              original.windowId,
              minimum,
            );
            await restoreElectronRendererContentSize(original);
            await wait(
              () => browser.execute(settingsUiSettled, initial),
              "NCTX settings viewport did not restore",
            );
          },
        );
      },
    },
    async () => {
      if (!(await $(settingsTestSelector(TID_TASK_SETTINGS_BUTTON)).isDisplayed()))
        await click(settingsTestSelector("desktop-top-logo-sidebar-toggle"));
    },
  );
}

/** Page 来自统一 suite 的 full Root 远控 fixture；不新建 browser、Host 或 Agent。 */
export async function createNativeMobileSettingsDriver(
  page: Page,
): Promise<NativeSettingsLayoutDriver> {
  const original = page.viewportSize();
  const scroll = async (selector: string, index = 0) => {
    await page.locator(selector).nth(index).waitFor({ state: "visible", timeout: 20000 });
    await page.evaluate(scrollSettingsTarget, { selector, index });
    const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await wait(
      () => page.evaluate(settingsUiSettled, size),
      "NCTX mobile settings UI is still moving",
    );
  };
  return attachSettingsNavigation(
    {
      mobile: true,
      snapshot: (surface = "") => page.evaluate(readSettingsUi, surface),
      options: () => page.evaluate(readSettingsOptions),
      visible: (selector) => page.locator(selector).first().isVisible(),
      wait,
      scroll,
      click: async (selector, index = 0) => {
        await scroll(selector, index);
        expect(await page.evaluate(settingsTargetIsHit, { selector, index })).toBe(true);
        await page.locator(selector).nth(index).click();
      },
      pressEscape: () => page.keyboard.press("Escape"),
      resize: async (width) => {
        await page.setViewportSize({ width, height: 900 });
        await wait(
          () => page.evaluate(settingsUiSettled, { width, height: 900 }),
          "NCTX mobile settings viewport did not settle",
        );
      },
      parameterLayout: (width) => assertNativeContextMobileParameterLayout(page, width, "defaults"),
      screenshot: async (path) => {
        await page.screenshot({ path: await assertNativeContextTestPath(path) });
      },
      restoreViewport: async () => {
        if (original) {
          await page.setViewportSize(original);
          await wait(
            () => page.evaluate(settingsUiSettled, original),
            "NCTX mobile settings viewport did not restore",
          );
        }
      },
    },
    () => showMobileTaskHome(page),
  );
}
