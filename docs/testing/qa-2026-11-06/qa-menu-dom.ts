/** 外置 QA：可见性和菜单状态在同一次 renderer DOM 快照读取，避免退出动画中的旧 WDIO handle。 */
import type { ChainablePromiseElement } from "webdriverio";
export interface QaVisibleControl {
  index: number;
  text: string;
  state: string | null;
  checked: string | null;
}

export async function visibleControls(
  selector: string,
  pattern?: RegExp,
): Promise<QaVisibleControl[]> {
  return (await browser.execute(
    `
    const selector = arguments[0], source = arguments[1], flags = arguments[2];
    const pattern = source === null ? null : new RegExp(source, flags);
    const result = [];
    const elements = document.querySelectorAll(selector);
    for (let index = 0; index < elements.length; index++) {
      const element = elements[index];
      if (!element.isConnected || !element.checkVisibility({checkOpacity:true, checkVisibilityCSS:true})) continue;
      if (element.closest('[role="menu"][data-state="closed"], [role="listbox"][data-state="closed"]')) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const text = (element.innerText || element.textContent || "").trim();
      if (pattern) { pattern.lastIndex = 0; if (!pattern.test(text)) continue; }
      result.push({index, text, state:element.getAttribute("data-state"), checked:element.getAttribute("aria-checked")});
    }
    return result;
  `,
    selector,
    pattern?.source ?? null,
    pattern?.flags ?? "",
  )) as QaVisibleControl[];
}

export async function visibleControl(selector: string, pattern?: RegExp) {
  const control = (await visibleControls(selector, pattern))[0];
  return control ? (await $$(selector))[control.index] : undefined;
}

export async function scrollQaControlIntoView(
  element: WebdriverIO.Element | ChainablePromiseElement,
) {
  const target = await element.getElement();
  // 此前超时始于无条件wheel准备；先核命中，仅需要时滚动，Driver错误继续上抛。
  const visible = await browser.execute((control: HTMLElement) => {
    const rect = control.getBoundingClientRect(),
      x = rect.left + rect.width / 2,
      y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return (
      x >= 0 &&
      x < innerWidth &&
      y >= 0 &&
      y < innerHeight &&
      Boolean(hit && (hit === control || control.contains(hit)))
    );
  }, target);
  if (!visible)
    await browser.execute(
      (control: HTMLElement) =>
        control.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" }),
      target,
    );
}

export async function clickVisibleControl(
  selector: string,
  pattern: RegExp | undefined,
  prefix: string,
) {
  await browser.waitUntil(
    async () => {
      const element = await visibleControl(selector, pattern);
      if (!element) return false;
      try {
        await scrollQaControlIntoView(element);
        await element.waitForClickable({ timeout: 15_000 });
        await element.click();
        return true;
      } catch (error) {
        // 原生 stale 明确表示目标已脱离文档，重查同一可见动作；其它 driver/交互错误保留。
        if (error instanceof Error && /stale element reference/u.test(error.message)) return false;
        throw error;
      }
    },
    {
      timeout: 15_000,
      timeoutMsg: `${prefix} visible control missing: ${selector} ${pattern?.source ?? ""}`,
    },
  );
}

export async function closeVisibleMenus(prefix: string) {
  for (
    let attempt = 0;
    attempt < 4 && (await visibleControls('[role="menu"],[role="listbox"]')).length;
    attempt++
  )
    await browser.keys("Escape");
  await browser.waitUntil(
    async () => (await visibleControls('[role="menu"],[role="listbox"]')).length === 0,
    { timeout: 10_000, timeoutMsg: `${prefix} menu did not close` },
  );
}
