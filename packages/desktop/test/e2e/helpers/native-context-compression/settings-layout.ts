import { join } from "node:path";
import { ServiceChannels, type AppSettings, type LocalePreference } from "@zcode/shared";
import {
  TID_SETTINGS_LOCALE_SELECT_ITEM,
  TID_SETTINGS_LOCALE_SELECT_TRIGGER,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  testId,
} from "@zcode/shared/test-ids";
import {
  NATIVE_CONTEXT_PARAMETER_FIELDS,
  nativeContextConfigurationSchema,
} from "@zcode/shared/native-context-compression";
import type { Page } from "playwright-core";
import { callHandoffHost } from "../remote-project-handoff-probe.js";
import { runNativeContextCleanup, withNativeContextCleanup } from "./cleanup.js";
import { assertNativeContextTestPath } from "./environment.js";
import { getNativeContextStatus, nativeContextCurrentTarget } from "./queries.js";
import { assertNativeContextZeroByteAxis } from "./trend-zero-axis.js";
import {
  createNativeDesktopSettingsDriver,
  createNativeMobileSettingsDriver,
  closeNativeSettingsDialogs as closeNativeDialogs,
  withNativeSettingsEvidence,
  settingsTestSelector as tid,
  type NativeSettingsLayoutDriver,
} from "./settings-layout-driver.js";

type FixedLocale = "zh-CN" | "en-US";
type ThemePreference = "system" | "zai-dark" | "zai-light";
const themes: ThemePreference[] = ["system", "zai-dark", "zai-light"];
const language = {
  "zh-CN": {
    title: "上下文压缩",
    defaults: "新任务默认参数",
    task: "当前任务参数",
    auto: "自动压缩",
    tabs: ["概览", "趋势", "压缩记录", "参数"],
    charts: ["请求输入与压缩趋势", "缓存趋势", "图片发送趋势"],
  },
  "en-US": {
    title: "Context compression",
    defaults: "Default parameters",
    task: "Task parameters",
    auto: "Automatic compression",
    tabs: ["Overview", "Trends", "Records", "Parameters"],
    charts: ["Request input and compression", "Cache trend", "Image send trend"],
  },
} satisfies Record<FixedLocale, object>;

async function readSettingsOwner() {
  const {
    nativeContextCompression: defaults,
    localePreference,
    locale,
  } = await callHandoffHost<AppSettings>(ServiceChannels.Setting, "get");
  if (!defaults) throw new Error("NCTX settings owner has no compression defaults");
  return {
    localePreference,
    locale,
    defaults: {
      version: defaults.version,
      configuration: nativeContextConfigurationSchema.parse(defaults.configuration),
    },
  };
}

const themeTrigger = `${tid(TID_SETTINGS_PAGE)}[data-active-section="appearance"] [role="combobox"]`;

async function openSection(driver: NativeSettingsLayoutDriver, section: string) {
  await driver.openSettings();
  await driver.click(tid(testId(TID_SETTINGS_SECTION_NAV, section)));
  await driver.wait(
    () => driver.visible(`${tid(TID_SETTINGS_PAGE)}[data-active-section="${section}"]`),
    "NCTX settings did not select the requested section",
  );
}

export async function captureLocale(driver: NativeSettingsLayoutDriver): Promise<LocalePreference> {
  await openSection(driver, "general");
  await driver.click(tid(TID_SETTINGS_LOCALE_SELECT_TRIGGER));
  await driver.wait(() => driver.visible('[role="option"]'), "NCTX language options did not open");
  const selected = (await driver.options()).find((option) => option.selected);
  const value = (["system", "zh-CN", "en-US"] as const).find(
    (candidate) => selected?.testId === testId(TID_SETTINGS_LOCALE_SELECT_ITEM, candidate),
  );
  await driver.pressEscape();
  if (!value) throw new Error("NCTX the actual selected language preference is unknown");
  return value;
}

async function captureTheme(driver: NativeSettingsLayoutDriver): Promise<ThemePreference> {
  await openSection(driver, "appearance");
  await driver.click(themeTrigger);
  await driver.wait(() => driver.visible('[role="option"]'), "NCTX theme options did not open");
  const options = await driver.options();
  expect(options).toHaveLength(3);
  expect(options.map((option) => option.label)).toEqual(
    options[0]?.label === "系统" ? ["系统", "深色", "浅色"] : ["System", "Dark", "Light"],
  );
  const value = themes[options.findIndex((option) => option.selected)];
  await driver.pressEscape();
  if (!value) throw new Error("NCTX the actual selected theme preference is unknown");
  return value;
}

export async function chooseLocale(driver: NativeSettingsLayoutDriver, value: LocalePreference) {
  await openSection(driver, "general");
  await driver.click(tid(TID_SETTINGS_LOCALE_SELECT_TRIGGER));
  await driver.wait(() => driver.visible('[role="option"]'), "NCTX language options did not open");
  await driver.click(tid(testId(TID_SETTINGS_LOCALE_SELECT_ITEM, value)));
  await driver.wait(async () => {
    const ui = await driver.snapshot();
    const owner = await readSettingsOwner();
    return (
      ui.localePreference === value &&
      owner.localePreference === value &&
      (value === "system" || owner.locale === value)
    );
  }, "NCTX language UI and its owning Host preference did not converge");
}

function assertTheme(
  ui: Awaited<ReturnType<NativeSettingsLayoutDriver["snapshot"]>>,
  theme: ThemePreference,
) {
  const dark = theme === "system" ? ui.systemDark : theme === "zai-dark";
  expect(ui.themePreference).toBe(theme);
  expect(ui.dark).toBe(dark);
  expect(ui.lightClass).toBe(!dark);
  expect(ui.darkClass).toBe(dark);
  if (ui.browserThemeSurface !== null) {
    expect(ui.browserThemeSurface).toBe(dark ? "dark" : "light");
    expect(ui.colorScheme).toBe(dark ? "dark" : "light");
    expect(ui.themeColor).toBe(ui.backgroundToken);
  }
}

async function chooseTheme(driver: NativeSettingsLayoutDriver, theme: ThemePreference) {
  await openSection(driver, "appearance");
  await driver.click(themeTrigger);
  await driver.wait(() => driver.visible('[role="option"]'), "NCTX theme options did not open");
  expect(await driver.options()).toHaveLength(3);
  await driver.click('[role="option"]', themes.indexOf(theme));
  await driver.wait(async () => {
    const ui = await driver.snapshot();
    const dark = theme === "system" ? ui.systemDark : theme === "zai-dark";
    return (
      ui.themePreference === theme &&
      ui.dark === dark &&
      ui.darkClass === dark &&
      ui.lightClass === !dark
    );
  }, "NCTX theme preference did not reach the actual page surface");
  assertTheme(await driver.snapshot(), theme);
}

async function openTaskParameters(driver: NativeSettingsLayoutDriver) {
  if (!(await driver.visible(tid("native-context-popover"))))
    await driver.click(tid("native-context-entry"));
  await driver.click(tid("native-context-open-parameters"));
  await driver.wait(
    () => driver.visible(tid("native-context-details")),
    "NCTX task details did not open",
  );
  await driver.click(tid("native-context-scope"));
  await driver.wait(() => driver.visible('[role="option"]'), "NCTX editing scopes did not open");
  const options = await driver.options();
  expect(options).toHaveLength(2);
  const previous = options.findIndex((option) => option.selected);
  if (previous < 0) throw new Error("NCTX the current editing scope is unknown");
  await driver.click('[role="option"]', 0);
  await driver.click(tid("native-context-tab-parameters"));
  await driver.wait(
    () => driver.visible(tid("native-context-parameters-task")),
    "NCTX task parameters did not open",
  );
  return previous;
}

async function assertLocalizedSurface(
  driver: NativeSettingsLayoutDriver,
  selector: string,
  locale: FixedLocale,
  theme: ThemePreference,
  width: number,
  kind: "defaults" | "task" | "trends",
) {
  await driver.scroll(selector);
  const ui = await driver.snapshot(selector);
  assertTheme(ui, theme);
  const surface = ui.surface;
  if (!surface) throw new Error("NCTX the localized native surface is missing");
  expect(surface.x).toBeGreaterThanOrEqual(0);
  expect(surface.right).toBeLessThanOrEqual(width + 1);
  expect(surface.bottom).toBeLessThanOrEqual(ui.height + 1);
  expect(surface.scrollWidth).toBeLessThanOrEqual(surface.clientWidth + 1);
  expect(surface.background).not.toMatch(/^transparent$|^rgba\(0, 0, 0, 0\)$/u);
  expect(surface.text).not.toContain("nativeContext.");
  expect(surface.title).toBe(
    kind === "defaults" ? language[locale].defaults : language[locale].title,
  );
  if (kind !== "defaults") {
    expect(surface.tabs).toEqual(language[locale].tabs);
    if (!surface.tablist || !surface.detailScroll)
      throw new Error("NCTX the tablist or its content geometry is missing");
    expect(surface.tabButtons).toHaveLength(4);
    for (const tab of surface.tabButtons) {
      expect(tab.height).toBeGreaterThanOrEqual(44);
      expect(tab.x).toBeGreaterThanOrEqual(surface.tablist.x - 1);
      expect(tab.right).toBeLessThanOrEqual(surface.tablist.right + 1);
      expect(tab.y).toBeGreaterThanOrEqual(surface.tablist.y - 1);
      expect(tab.bottom).toBeLessThanOrEqual(surface.tablist.bottom + 1);
    }
    expect(surface.detailScroll.y).toBeGreaterThanOrEqual(surface.tablist.bottom - 1);
  }
  if (kind === "trends") {
    for (const title of language[locale].charts) expect(surface.text).toContain(title);
  } else {
    const firstField = NATIVE_CONTEXT_PARAMETER_FIELDS.find((field) => !field.advanced);
    if (!firstField) throw new Error("NCTX no ordinary parameter descriptor");
    expect(surface.text).toContain(firstField.labels[locale]);
    expect(surface.text).toContain(language[locale][kind]);
    expect(surface.text).toContain(language[locale].auto);
  }
  return { background: surface.background, foreground: surface.foreground };
}

async function exerciseSettingsLayout(
  driver: NativeSettingsLayoutDriver,
  evidenceDirectory: string,
  widths: readonly number[],
) {
  const target = await nativeContextCurrentTarget();
  const before = await getNativeContextStatus(target);
  const ownerBefore = await readSettingsOwner();
  const uiBefore = await driver.snapshot();
  if (uiBefore.taskId !== target.sessionId)
    throw new Error("NCTX settings layout requires the original real task");
  let originalLocale: LocalePreference | undefined;
  let originalTheme: ThemePreference | undefined;
  let originalScope: number | undefined;
  let preferencesChanged = false;
  await withNativeContextCleanup(
    () =>
      withNativeSettingsEvidence(driver, evidenceDirectory, async () => {
        originalLocale = await captureLocale(driver);
        originalTheme = await captureTheme(driver);
        // 宿主语言会被真实设置 UI 持久化；先确认初始归属一致，避免独立偏好被当作共享事实覆盖。
        if (ownerBefore.localePreference && originalLocale !== ownerBefore.localePreference)
          throw new Error("NCTX frontend and Host start with different language preferences");
        for (const width of widths) {
          await driver.resize(width);
          for (const locale of ["zh-CN", "en-US"] as const) {
            const colors: Array<{ background: string; foreground: string }> = [];
            for (const theme of ["zai-light", "zai-dark"] as const) {
              preferencesChanged = true;
              await chooseTheme(driver, theme);
              await chooseLocale(driver, locale);
              await driver.click(tid("native-context-defaults-open"));
              await driver.wait(
                () => driver.visible(tid("native-context-defaults-dialog")),
                "NCTX the independent defaults dialog did not open",
              );
              expect(await driver.visible(tid("native-context-details"))).toBe(false);
              if (theme === "zai-light") await driver.parameterLayout(width);
              colors.push(
                await assertLocalizedSurface(
                  driver,
                  tid("native-context-parameters-defaults"),
                  locale,
                  theme,
                  width,
                  "defaults",
                ),
              );
              const prefix = `native-settings-${driver.mobile ? "mobile" : "desktop"}-${width}-${theme}-${locale}`;
              await driver.screenshot(join(evidenceDirectory, `${prefix}-defaults.png`));
              await closeNativeDialogs(driver);
              await driver.returnTask(target.sessionId);
              const scope = await openTaskParameters(driver);
              originalScope ??= scope;
              await assertLocalizedSurface(
                driver,
                tid("native-context-parameters-task"),
                locale,
                theme,
                width,
                "task",
              );
              await driver.screenshot(join(evidenceDirectory, `${prefix}-task-parameters.png`));
              await driver.click(tid("native-context-tab-trends"));
              await driver.wait(
                () => driver.visible(`${tid("native-context-input-chart")} svg`),
                "NCTX the actual input trend did not render",
              );
              for (const chart of ["input-chart", "cache-chart", "image-chart"])
                await driver.wait(
                  () => driver.visible(`${tid(`native-context-${chart}`)} svg`),
                  "NCTX a secondary chart did not render",
                );
              if (
                !driver.mobile &&
                width === widths[0] &&
                locale === "zh-CN" &&
                theme === "zai-light"
              )
                await assertNativeContextZeroByteAxis(locale);
              await assertLocalizedSurface(
                driver,
                tid("native-context-trends"),
                locale,
                theme,
                width,
                "trends",
              );
              await driver.screenshot(join(evidenceDirectory, `${prefix}-trends.png`));
              await driver.scroll(tid("native-context-image-chart"));
              await driver.screenshot(join(evidenceDirectory, `${prefix}-secondary-trends.png`));
              await closeNativeDialogs(driver);
            }
            expect(colors[0]?.background).not.toBe(colors[1]?.background);
            expect(colors[0]?.foreground).not.toBe(colors[1]?.foreground);
          }
        }
      }),
    async () => {
      // 原因：手机偏好不能用桌面解析值覆盖；沿各自真实 UI 还原捕获的 system/显式偏好。
      await runNativeContextCleanup(
        () => closeNativeDialogs(driver),
        // 原因：首错可能留在裁切入口的窄视口；先恢复安全宽度，再还原偏好，原视口仍由外层最后恢复。
        () => driver.resize(1024),
        async () => {
          if (preferencesChanged && originalLocale) await chooseLocale(driver, originalLocale);
        },
        async () => {
          if (preferencesChanged && originalTheme) await chooseTheme(driver, originalTheme);
        },
        async () => {
          if (uiBefore.lastSection) await openSection(driver, uiBefore.lastSection);
          await driver.returnTask(target.sessionId);
        },
        async () => {
          if (originalScope === 1) {
            await openTaskParameters(driver);
            await driver.click(tid("native-context-scope"));
            await driver.wait(
              () => driver.visible('[role="option"]'),
              "NCTX editing scopes did not reopen for restoration",
            );
            await driver.click('[role="option"]', originalScope);
            await closeNativeDialogs(driver);
          }
        },
        async () => {
          const ownerAfter = await readSettingsOwner();
          expect(ownerAfter.defaults).toEqual(ownerBefore.defaults);
          if (ownerBefore.localePreference)
            expect(ownerAfter.localePreference).toBe(ownerBefore.localePreference);
          if (ownerBefore.localePreference !== "system")
            expect(ownerAfter.locale).toBe(ownerBefore.locale);
          const after = await getNativeContextStatus(target);
          expect(after.policy).toEqual(before.policy);
          expect(after.revision).toBe(before.revision);
          const ui = await driver.snapshot();
          expect(ui.taskId).toBe(target.sessionId);
          if (preferencesChanged && originalTheme) assertTheme(ui, originalTheme);
          if (preferencesChanged && originalLocale)
            expect(ui.localePreference).toBe(originalLocale);
        },
      );
    },
  );
}

/** 前置：统一 suite 的原任务可见且未打开弹窗；不改压缩策略/Provider、不产生模型请求。 */
export async function assertNativeContextSettingsLayout(evidenceDirectory: string): Promise<void> {
  await assertNativeContextTestPath(evidenceDirectory);
  const driver = await createNativeDesktopSettingsDriver();
  await withNativeContextCleanup(
    () => exerciseSettingsLayout(driver, evidenceDirectory, [1024, 736, 390, 320]),
    () => driver.restoreViewport(),
  );
}

/** 同一配对 Page，在 mobile recovery 后、冷重启关闭手机前调用。 */
export async function assertNativeContextMobileSettingsLayout(
  page: Page,
  evidenceDirectory: string,
): Promise<void> {
  await assertNativeContextTestPath(evidenceDirectory);
  const driver = await createNativeMobileSettingsDriver(page);
  await withNativeContextCleanup(
    () => exerciseSettingsLayout(driver, evidenceDirectory, [390, 320]),
    () => driver.restoreViewport(),
  );
}
