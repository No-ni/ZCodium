import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ServiceChannels, type AppSettings, type LocalePreference } from "@zcode/shared";
import {
  TID_SETTINGS_LOCALE_SELECT_TRIGGER,
  TID_V4_SESSION_PANE,
  testId,
} from "@zcode/shared/test-ids";
import type { Page } from "playwright-core";
import { callHandoffHost } from "../remote-project-handoff-probe.js";
import { getUpstreamRequestRecordCount } from "../conversation-session-network.js";
import { runNativeContextCleanup, withNativeContextCleanup } from "./cleanup.js";
import { assertNativeContextTestPath } from "./environment.js";
import { getNativeContextStatus, nativeContextCurrentTarget } from "./queries.js";
import { captureLocale, chooseLocale } from "./settings-layout.js";
import {
  closeNativeSettingsDialogs,
  createNativeMobileSettingsDriver,
  settingsTestSelector as tid,
  withNativeSettingsEvidence,
} from "./settings-layout-driver.js";

/** 复用已配对 Page 与设置动作，验证 Host system 偏好在真实 reload 后仍有效。 */
export async function assertNativeContextMobileSystemLocale(page: Page, evidenceDirectory: string) {
  await assertNativeContextTestPath(evidenceDirectory);
  const driver = await createNativeMobileSettingsDriver(page);
  const target = await nativeContextCurrentTarget();
  const before = await getNativeContextStatus(target);
  const ownerBefore = await callHandoffHost<AppSettings>(ServiceChannels.Setting, "get");
  const requestCount = await getUpstreamRequestRecordCount();
  // 原因：WDIO 移除首参且只暴露 Main 的 electron；解构 app 会丢失绑定并读成 undefined。
  const systemLocale = await browser.electron.execute((electron) => {
    const preferred = electron.app.getPreferredSystemLanguages?.()[0] ?? electron.app.getLocale();
    return preferred.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
  });
  const samples: unknown[] = [];
  const sampleLocale = async (phase: string) => {
    const [owner, ui, label] = await Promise.all([
      callHandoffHost<AppSettings>(ServiceChannels.Setting, "get"),
      driver.snapshot(),
      page.getByTestId(TID_SETTINGS_LOCALE_SELECT_TRIGGER).first().textContent(),
    ]);
    // 原因：失败清理会恢复旧偏好；只在清理前保存语言枚举，不能导出完整设置解释历史现场。
    samples.push({
      phase,
      expectedSystemLocale:
        systemLocale === "zh-CN" || systemLocale === "en-US" ? systemLocale : "unknown",
      ownerPreference: owner.localePreference,
      ownerLocale: owner.locale,
      mobilePreference: ["system", "zh-CN", "en-US"].includes(ui.localePreference ?? "")
        ? ui.localePreference
        : "unknown",
      mobileLanguage: label?.includes("系统")
        ? "zh-CN"
        : label?.includes("System")
          ? "en-US"
          : "unknown",
    });
    await writeFile(
      await assertNativeContextTestPath(
        join(evidenceDirectory, "native-settings-mobile-system-phases.json"),
      ),
      JSON.stringify({ samples }, null, 2),
    );
  };
  let originalLocale: LocalePreference | undefined;
  const assertSystem = async (phase: string) => {
    expect(await captureLocale(driver)).toBe("system");
    await sampleLocale(`${phase}-before`);
    try {
      await driver.wait(async () => {
        const owner = await callHandoffHost<AppSettings>(ServiceChannels.Setting, "get");
        return owner.localePreference === "system" && owner.locale === systemLocale;
      }, "NCTX mobile system language did not match the actual Electron OS language");
    } catch (error) {
      try {
        await sampleLocale(`${phase}-failed`);
      } catch (samplingError) {
        throw new AggregateError([error, samplingError], "NCTX system locale evidence failed");
      }
      throw error;
    }
    await sampleLocale(`${phase}-converged`);
    await driver.click(tid("native-context-defaults-open"));
    await driver.wait(
      () => driver.visible(tid("native-context-defaults-dialog")),
      "NCTX system language defaults dialog did not open",
    );
    await driver.wait(async () => {
      const ui = await driver.snapshot(tid("native-context-parameters-defaults"));
      return (
        ui.surface?.title === (systemLocale === "zh-CN" ? "新任务默认参数" : "Default parameters")
      );
    }, "NCTX the actual native defaults page did not use the resolved Host language");
    await driver.screenshot(join(evidenceDirectory, `native-settings-mobile-system-${phase}.png`));
    await closeNativeSettingsDialogs(driver);
  };
  await withNativeContextCleanup(
    () =>
      withNativeSettingsEvidence(driver, evidenceDirectory, async () => {
        originalLocale = await captureLocale(driver);
        await sampleLocale("before-selection");
        expect(["zh-CN", "en-US"]).toContain(systemLocale);
        // 原因：原偏好可能已经是 system；先改变语言才能验证重新解析，而不是重复选择。
        await chooseLocale(driver, systemLocale === "zh-CN" ? "en-US" : "zh-CN");
        await sampleLocale("explicit-before-system");
        await chooseLocale(driver, "system");
        await assertSystem("selected");
        await driver.returnTask(target.sessionId);
        await page.reload({ waitUntil: "domcontentloaded" });
        // 原因：DOM 就绪早于共享任务恢复；导航前等待真实 pane 身份，避免一次可见性读取跳过返回。
        await driver.wait(async () => {
          const ui = await driver.snapshot();
          return (
            ui.taskId === target.sessionId &&
            (await driver.visible(tid(testId(TID_V4_SESSION_PANE, "workspace-main"))))
          );
        }, "NCTX reloaded mobile did not restore the actual task before opening settings");
        await assertSystem("reloaded");
        await driver.returnTask(target.sessionId);
        const owner = await callHandoffHost<AppSettings>(ServiceChannels.Setting, "get");
        const after = await getNativeContextStatus(target);
        expect(owner.nativeContextCompression).toEqual(ownerBefore.nativeContextCompression);
        expect(after.policy).toEqual(before.policy);
        expect(after.revision).toBe(before.revision);
        expect(await getUpstreamRequestRecordCount()).toBe(requestCount);
        await writeFile(
          await assertNativeContextTestPath(
            join(evidenceDirectory, "native-settings-mobile-system.json"),
          ),
          JSON.stringify(
            {
              systemLocale,
              originalLocale,
              preference: owner.localePreference,
              resolvedLocale: owner.locale,
              reloaded: true,
              reloadedTaskReady: true,
              additionalProviderRequests: 0,
            },
            null,
            2,
          ),
        );
      }),
    () =>
      runNativeContextCleanup(
        () => closeNativeSettingsDialogs(driver),
        async () => {
          if (originalLocale) await chooseLocale(driver, originalLocale);
        },
        () => driver.returnTask(target.sessionId),
        () => driver.restoreViewport(),
      ),
  );
}
