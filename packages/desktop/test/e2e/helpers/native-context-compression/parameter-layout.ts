import { NATIVE_CONTEXT_PARAMETER_FIELDS } from "@zcode/shared/native-context-compression";
import type { Page } from "playwright-core";
import {
  restoreElectronRendererContentSize,
  setCurrentElectronRendererContentSize,
} from "../desktop-app.js";
import { runNativeContextCleanup, withNativeContextCleanup } from "./cleanup.js";

type ParameterTarget = "task" | "defaults";
type LayoutKey = "Tab" | "Shift+Tab" | "Enter" | "Space";
type LayoutInput = { target: ParameterTarget; selector?: string };

function parameterLayoutSettled({
  target,
  width,
  height,
}: {
  target: ParameterTarget;
  width: number;
  height: number;
}) {
  const root = document.querySelector(`[data-testid="native-context-parameters-${target}"]`);
  const dialog = root?.closest('[role="dialog"]');
  return (
    !!dialog &&
    innerWidth === width &&
    innerHeight === height &&
    dialog
      .getAnimations({ subtree: true })
      .every(
        (animation) =>
          animation.playState !== "running" ||
          animation.effect?.getComputedTiming().iterations === Infinity,
      )
  );
}

function scrollParameterTarget({ target, selector }: LayoutInput) {
  const root = document.querySelector(`[data-testid="native-context-parameters-${target}"]`);
  const element = selector ? root?.querySelector(selector) : null;
  if (!element) throw new Error("NCTX parameter scroll target is missing");
  // 原因：浏览器的最小滚入曾把 summary 放在 sticky 底栏下面；保留真实滚动来复现。
  element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
}

function readParameterGeometry({ target, selector }: LayoutInput) {
  const root = document.querySelector<HTMLElement>(
    `[data-testid="native-context-parameters-${target}"]`,
  );
  const dialog = root?.closest<HTMLElement>('[role="dialog"]');
  const body = root?.querySelector<HTMLElement>('[data-testid="native-context-parameter-scroll"]');
  const footer = root?.querySelector<HTMLElement>(
    '[data-testid="native-context-parameter-footer"]',
  );
  if (!root || !dialog || !body || !footer) throw new Error("NCTX parameter layout is unavailable");
  const element = selector ? root.querySelector<HTMLElement>(selector) : null;
  if (selector && !element) throw new Error("NCTX parameter interaction target is missing");
  // 原因：Playwright 只序列化函数本体；匿名 map 避免局部命名函数依赖模块 __name。
  const bounds = [dialog, body, footer, ...(element ? [element] : [])].map((target) => {
    const rect = target.getBoundingClientRect();
    return {
      x: rect.x,
      y: rect.y,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  });
  const rect = element ? bounds[3]! : undefined;
  const hit = rect
    ? document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    : null;
  let scrollers = 0;
  for (
    let ancestor = element?.parentElement;
    ancestor && ancestor !== dialog;
    ancestor = ancestor.parentElement
  ) {
    if (["auto", "scroll"].includes(getComputedStyle(ancestor).overflowY)) scrollers += 1;
  }
  const disabled =
    element instanceof HTMLButtonElement ||
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
      ? element.disabled
      : element?.getAttribute("aria-disabled") === "true";
  return {
    viewport: { width: innerWidth, height: innerHeight },
    dialog: bounds[0]!,
    body: { ...bounds[1]!, width: body.clientWidth, contentWidth: body.scrollWidth },
    footer: bounds[2]!,
    siblings: body.parentElement === footer.parentElement,
    activeInDialog: dialog.contains(document.activeElement),
    animationPending: dialog.getAnimations({ subtree: true }).some((animation) => {
      const timing = animation.effect?.getComputedTiming();
      return animation.playState === "running" && timing?.iterations !== Infinity;
    }),
    element: element
      ? {
          ...bounds[3]!,
          disabled,
          open: element.closest("details")?.open ?? null,
          focused: element === document.activeElement || element.contains(document.activeElement),
          hit: hit === element || (hit !== null && element.contains(hit)),
          inBody: body.contains(element),
          scrollers,
        }
      : null,
  };
}

type ParameterGeometry = ReturnType<typeof readParameterGeometry>;
interface LayoutDriver {
  read(selector?: string): Promise<ParameterGeometry>;
  scroll(selector: string): Promise<void>;
  click(selector: string): Promise<void>;
  press(key: LayoutKey): Promise<void>;
}

const summarySelector = (id: string) => `[data-testid="native-context-${id}"] > summary`;
const actionSelector = (id: string) => `[data-testid="native-context-${id}"]`;

function assertParameterGeometry(geometry: ParameterGeometry, width: number) {
  expect(Math.abs(geometry.viewport.width - width)).toBeLessThanOrEqual(1);
  expect(geometry.dialog.x).toBeGreaterThanOrEqual(0);
  expect(geometry.dialog.right).toBeLessThanOrEqual(width + 1);
  expect(geometry.dialog.bottom).toBeLessThanOrEqual(geometry.viewport.height + 1);
  expect(geometry.body.contentWidth).toBeLessThanOrEqual(geometry.body.width + 1);
  expect(geometry.body.height).toBeGreaterThan(44);
  expect(geometry.body.bottom).toBeLessThanOrEqual(geometry.footer.y + 1);
  expect(geometry.footer.bottom).toBeLessThanOrEqual(geometry.dialog.bottom + 1);
  expect(geometry.siblings).toBe(true);
}

function assertParameterTarget(geometry: ParameterGeometry) {
  const element = geometry.element;
  if (!element) throw new Error("NCTX no parameter target geometry");
  expect(element.width).toBeGreaterThan(0);
  expect(element.height).toBeGreaterThan(0);
  expect(element.x).toBeGreaterThanOrEqual(geometry.dialog.x - 1);
  expect(element.right).toBeLessThanOrEqual(geometry.dialog.right + 1);
  const frame = element.inBody ? geometry.body : geometry.footer;
  expect(element.y).toBeGreaterThanOrEqual(frame.y - 1);
  expect(element.bottom).toBeLessThanOrEqual(frame.bottom + 1);
  expect(element.scrollers).toBe(element.inBody ? 1 : 0);
  if (!element.disabled) expect(element.hit).toBe(true);
}

async function navigateToTarget(driver: LayoutDriver, selector: string, key: LayoutKey) {
  for (let step = 0; step < NATIVE_CONTEXT_PARAMETER_FIELDS.length * 4; step += 1) {
    if ((await driver.read(selector)).element?.focused) return;
    await driver.press(key);
    expect((await driver.read()).activeInDialog).toBe(true);
  }
  throw new Error("NCTX keyboard could not reach the parameter target");
}

async function exerciseParameterLayout(driver: LayoutDriver, width: number) {
  assertParameterGeometry(await driver.read(), width);
  const summaries = [summarySelector("advanced-prompts"), summarySelector("complete-editor")];
  const originalOpen = await Promise.all(
    summaries.map(async (selector) => ({
      selector,
      open: (await driver.read(selector)).element?.open,
    })),
  );
  await withNativeContextCleanup(
    async () => {
      for (const selector of summaries) {
        await driver.scroll(selector);
        assertParameterTarget(await driver.read(selector));
        const before = (await driver.read(selector)).element?.open;
        await driver.click(selector);
        expect((await driver.read(selector)).element?.open).toBe(!before);
        if (!(await driver.read(selector)).element?.open) await driver.click(selector);
        expect((await driver.read(selector)).element?.focused).toBe(true);
        await driver.press("Space");
        expect((await driver.read(selector)).element?.open).toBe(false);
        await driver.press("Shift+Tab");
        expect((await driver.read(selector)).element?.focused).toBe(false);
        expect((await driver.read()).activeInDialog).toBe(true);
        await driver.press("Tab");
        expect((await driver.read(selector)).element?.focused).toBe(true);
        assertParameterTarget(await driver.read(selector));
        await driver.press("Enter");
        expect((await driver.read(selector)).element?.open).toBe(true);
        await driver.press("Space");
        expect((await driver.read(selector)).element?.open).toBe(false);
        await driver.press("Enter");
        expect((await driver.read(selector)).element?.open).toBe(true);
      }
      const last = NATIVE_CONTEXT_PARAMETER_FIELDS.filter(
        (field) => field.group === "prompts" && field.advanced,
      ).at(-1);
      if (!last) throw new Error("NCTX last advanced parameter is missing");
      const lastSelector = actionSelector(`parameter-${last.path}`);
      expect((await driver.read(lastSelector)).element?.disabled).toBe(false);
      await navigateToTarget(driver, lastSelector, "Shift+Tab");
      assertParameterTarget(await driver.read(lastSelector));
      for (const action of [
        "json-load",
        "json-restore",
        "export-configuration",
        "restore-all",
        "save-parameters",
      ]) {
        const selector = actionSelector(action);
        await driver.scroll(selector);
        const geometry = await driver.read(selector);
        assertParameterTarget(geometry);
        if (!geometry.element?.disabled) {
          await navigateToTarget(driver, selector, "Tab");
          assertParameterTarget(await driver.read(selector));
        }
      }
      assertParameterGeometry(await driver.read(), width);
    },
    async () => {
      await runNativeContextCleanup(
        ...originalOpen.map(({ selector, open }) => async () => {
          if ((await driver.read(selector)).element?.open !== open) {
            await driver.scroll(selector);
            await driver.click(selector);
          }
        }),
      );
    },
  );
}

/** 调用前打开 task 或 defaults 参数页；同样支持常规设置的 defaults-dialog。 */
export async function assertNativeContextParameterLayout(width: number, target: ParameterTarget) {
  const originalViewport = await browser.execute(() => ({
    width: innerWidth,
    height: innerHeight,
  }));
  const original = await setCurrentElectronRendererContentSize(1024, 850);
  const minimum = await browser.electron.execute((electron, id) => {
    const window = electron.BrowserWindow.fromId(id)!;
    const previous = window.getMinimumSize();
    window.setMinimumSize(320, 400);
    return previous;
  }, original.windowId);
  await withNativeContextCleanup(
    async () => {
      await setCurrentElectronRendererContentSize(width, 850);
      const prefix = `[data-testid="native-context-parameters-${target}"]`;
      const driver: LayoutDriver = {
        read: (selector) => browser.execute(readParameterGeometry, { target, selector }),
        scroll: async (selector) => {
          await browser.execute(scrollParameterTarget, { target, selector });
        },
        click: async (selector) => {
          await $(`${prefix} ${selector}`).click();
        },
        press: async (key) => {
          await browser.keys(key === "Shift+Tab" ? ["Shift", "Tab"] : key);
        },
      };
      await browser.waitUntil(
        () => browser.execute(parameterLayoutSettled, { target, width, height: 850 }),
        { timeout: 10000, timeoutMsg: "NCTX parameter layout did not settle after resizing" },
      );
      await exerciseParameterLayout(driver, width);
    },
    async () => {
      await runNativeContextCleanup(
        async () => {
          await browser.electron.execute(
            (electron, id, size) => {
              electron.BrowserWindow.fromId(id)?.setMinimumSize(size[0]!, size[1]!);
            },
            original.windowId,
            minimum,
          );
        },
        async () => {
          await restoreElectronRendererContentSize(original);
          // 原因：窗口 API 的恢复回执早于弹窗宽度动画收口，下一场原生点击必须等真实视口。
          await browser.waitUntil(
            () => browser.execute(parameterLayoutSettled, { target, ...originalViewport }),
            {
              timeout: 10000,
              timeoutMsg: "NCTX parameter layout did not settle after restoring viewport",
            },
          );
        },
      );
    },
  );
}

/** 复用已配对的同 Host 手机 Page，不创建浏览器或 Agent。 */
export async function assertNativeContextMobileParameterLayout(
  page: Page,
  width: number,
  target: ParameterTarget,
) {
  const original = page.viewportSize();
  await withNativeContextCleanup(
    async () => {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForFunction(
        parameterLayoutSettled,
        { target, width, height: 900 },
        { timeout: 10000 },
      );
      const prefix = `[data-testid="native-context-parameters-${target}"]`;
      await exerciseParameterLayout(
        {
          read: (selector) => page.evaluate(readParameterGeometry, { target, selector }),
          scroll: (selector) => page.evaluate(scrollParameterTarget, { target, selector }),
          click: (selector) => page.locator(`${prefix} ${selector}`).click(),
          press: (key) => page.keyboard.press(key),
        },
        width,
      );
    },
    async () => {
      if (original) {
        await page.setViewportSize(original);
        await page.waitForFunction(
          parameterLayoutSettled,
          { target, ...original },
          { timeout: 10000 },
        );
      }
    },
  );
}
