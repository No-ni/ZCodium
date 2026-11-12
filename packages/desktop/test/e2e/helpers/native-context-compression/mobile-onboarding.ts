import type { Page } from "playwright-core";
import { ServiceChannels } from "@zcode/shared";
import { callHandoffHost } from "../remote-project-handoff-probe.js";
import type { NativeContextMobileEvidenceStage } from "./mobile-evidence.js";

export async function readNativeContextFirstRunHandled(): Promise<boolean> {
  const state = await callHandoffHost<{ handled: boolean }>(
    ServiceChannels.SettingsSync,
    "getFirstRunPromptState",
  );
  if (typeof state?.handled !== "boolean")
    throw new Error("NCTX mobile first-run owner returned an invalid state");
  return state.handled;
}

/** 仅通过真实迁移 UI 关闭首启提示；公开 Host port 只读，reload 复用当前配对 Page。 */
export async function prepareNativeContextMobileOnboarding(
  page: Page,
  recordStage?: (stage: NativeContextMobileEvidenceStage) => Promise<void>,
) {
  const cancel = page.getByTestId("onboarding-wizard-cancel");
  const handledBefore = await readNativeContextFirstRunHandled();
  let cancelled = false;
  if (!handledBefore || (await cancel.isVisible())) {
    await cancel.waitFor();
    expect(await page.locator("[data-wizard-step]").getAttribute("data-wizard-step")).toBe(
      "session",
    );
    await cancel.click();
    cancelled = true;
  }
  // UI close 的写入异步结算；不能以弹窗隐藏代替同 Host 的持久化事实。
  await browser.waitUntil(readNativeContextFirstRunHandled, {
    timeout: 30_000,
    interval: 100,
    timeoutMsg: "NCTX real mobile onboarding Cancel did not persist its Host handled state",
  });
  await cancel.waitFor({ state: "hidden" });
  // 原因：reload 之后的页面等待可能先失败；reload 前后各落有限阶段，不等最终准入才留现场。
  await recordStage?.("onboarding-before-reload");
  await page.reload({ waitUntil: "domcontentloaded" });
  await recordStage?.("onboarding-after-reload");
  await page.bringToFront();
  await page.waitForFunction(() => document.visibilityState === "visible");
  await page.locator('[data-mobile-page="home"], [data-mobile-page="chat"]').waitFor();
  const handledAfterReload = await readNativeContextFirstRunHandled();
  expect(handledAfterReload).toBe(true);
  expect(await cancel.isVisible()).toBe(false);
  await recordStage?.("onboarding-ready");
  return { handledBefore, cancelled, handledAfter: true, handledAfterReload, reloaded: true };
}
