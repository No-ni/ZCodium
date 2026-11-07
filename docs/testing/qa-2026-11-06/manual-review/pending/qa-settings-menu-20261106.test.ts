import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TID_AUTOMATIONS_OPEN,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_LOCALE_SELECT_ITEM,
  TID_SETTINGS_LOCALE_SELECT_TRIGGER,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_NEW_BUTTON,
  TID_TASK_SETTINGS_BUTTON,
  TID_V4_COMPOSER_INPUT,
  testId,
} from "@zcode/shared/test-ids";
import { setCurrentElectronRendererContentSize } from "../../../../../packages/desktop/test/e2e/helpers/desktop-app.js";
import { prepareV4ConversationE2E } from "../../../../../packages/desktop/test/e2e/helpers/v4-conversation.js";
import { skipOccupationOnboardingIfPresent } from "../../../../../packages/desktop/test/e2e/helpers/occupation-onboarding.js";

interface SettingsCase {
  id: string;
  title: RegExp;
  selectors: string[];
  content?: RegExp;
}

// 中文说明：只锁定当前已装配的桌面菜单合同；历史隐藏 id 不能被上游用例误当作缺失。
const SETTINGS_CASES: SettingsCase[] = [
  {
    id: "general",
    title: /^(常规|General)$/u,
    selectors: ['[data-testid="settings-locale-select-trigger"]'],
  },
  {
    id: "appearance",
    title: /^(外观|Appearance)$/u,
    selectors: ['[role="combobox"]'],
    content: /代码|Code/u,
  },
  {
    id: "modelProvider",
    title: /^(模型设置|Model settings)$/u,
    selectors: [
      '[data-testid="model-provider-add-provider-button"]',
      '[data-model-provider-split-panel="true"]',
    ],
  },
  {
    id: "sourceServers",
    title: /^(Source 服务器|Source Servers)$/u,
    selectors: ["button"],
    content: /Source|Profile|刷新|Refresh/u,
  },
  {
    id: "personalization",
    title: /^(个性化|Personalization)$/u,
    selectors: ['[data-testid="settings-personalization-editor"]'],
  },
  {
    id: "memory",
    title: /^(记忆|Memory)$/u,
    selectors: ['[data-testid="settings-memory-switch"]'],
  },
  {
    id: "subagents",
    title: /^(子智能体|Subagents)$/u,
    selectors: ["input[placeholder]"],
    content: /子智能体|Subagents/u,
  },
  {
    id: "plugin",
    title: /^(插件|Plugins)$/u,
    selectors: [
      '[data-testid="plugin-settings-search"]',
      '[data-testid="plugin-settings-scope-trigger"]',
    ],
  },
  {
    id: "mcp",
    title: /^(MCP 服务器|MCP Servers)$/u,
    selectors: [
      '[data-testid="plugin-settings-search"]',
      '[data-testid="plugin-settings-scope-trigger"]',
    ],
  },
  {
    id: "skill",
    title: /^(技能|Skills)$/u,
    selectors: [
      '[data-testid="plugin-settings-search"]',
      '[data-testid="plugin-settings-scope-trigger"]',
    ],
  },
  {
    id: "commands",
    title: /^(命令|Commands)$/u,
    selectors: [
      '[data-testid="plugin-settings-search"]',
      '[data-testid="plugin-settings-scope-trigger"]',
    ],
  },
  { id: "hooks", title: /^(钩子|Hooks)$/u, selectors: ['[data-testid="hooks-settings-section"]'] },
  {
    id: "browser",
    title: /^(浏览器控制|Browser Use)$/u,
    selectors: ['[role="switch"]'],
    content: /浏览器|Browser/u,
  },
  {
    id: "computerUse",
    title: /^(电脑控制|Computer Use)$/u,
    selectors: ['[role="switch"]', ".text-warning"],
    content: /电脑控制|Computer Use|computer use/u,
  },
  {
    id: "shortcuts",
    title: /^(键盘快捷键|Keyboard Shortcuts)$/u,
    selectors: ['[data-testid="settings-shortcuts-section"]'],
  },
  {
    id: "usage",
    title: /^(使用统计|Usage stats)$/u,
    selectors: ['[role="tablist"]'],
    content: /用量|使用|Usage|usage/u,
  },
  {
    id: "projects",
    title: /^(项目|Projects)$/u,
    selectors: ['[data-testid="project-management"]'],
  },
  {
    id: "archives",
    title: /^(归档管理|Archive management)$/u,
    selectors: [
      '[data-testid="archive-management"]',
      '[data-testid="archive-auto-archive-switch"]',
    ],
  },
];

const HIDDEN_SECTIONS = [
  "remoteDevices",
  "dataSync",
  "automations",
  "plugins",
  "workspaceFileSearch",
  "migration",
];
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
let evidenceDirectory: string;

async function rejectLinks(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error("QA evidence path contains a link");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function prepareEvidenceDirectory(): Promise<void> {
  const configured = process.env.ZCODE_E2E_ARTIFACT_DIR;
  if (!configured) throw new Error("ZCODE_E2E_ARTIFACT_DIR must point inside this worktree");
  const repository = await realpath(REPOSITORY_ROOT);
  const target = resolve(configured);
  const suffix = relative(repository, target);
  if (!suffix || isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`)) {
    throw new Error("QA artifacts must be a child directory of this worktree");
  }
  let ancestor = repository;
  for (const segment of suffix.split(sep)) {
    ancestor = join(ancestor, segment);
    await rejectLinks(ancestor);
  }
  // 中文说明：先证明 runner 的已存在 artifact 根在本树，再创建本例子目录，避免真实用户目录写入。
  const artifact = await realpath(target);
  const realSuffix = relative(repository, artifact);
  if (isAbsolute(realSuffix) || realSuffix === ".." || realSuffix.startsWith(`..${sep}`)) {
    throw new Error("QA artifact realpath escaped this worktree");
  }
  evidenceDirectory = join(artifact, "qa-settings-menu-20261106");
  await rejectLinks(evidenceDirectory);
  await mkdir(evidenceDirectory, { recursive: true });
}

async function readSnapshot() {
  return browser.execute(() => {
    const displayed = (element: Element) => element.checkVisibility();
    const page = document.querySelector('[data-testid="settings-page"]');
    const main = page?.querySelector("main");
    return {
      settingsVisible: Boolean(page && displayed(page)),
      navigation: Array.from(
        page?.querySelectorAll<HTMLElement>("[data-settings-section-nav]") ?? [],
      ).map((element) => ({
        id: element.dataset.settingsSectionNav,
        label: element.innerText.trim(),
        current: element.getAttribute("aria-current"),
        visible: displayed(element),
      })),
      headings: Array.from(main?.querySelectorAll<HTMLElement>("h1,h2,h3") ?? [])
        .filter(displayed)
        .map((element) => element.innerText.trim()),
      controlIds: Array.from(main?.querySelectorAll<HTMLElement>("[data-testid]") ?? [])
        .filter(displayed)
        .map((element) => element.dataset.testid),
      themeClasses: Array.from(document.documentElement.classList),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      primaryNavigationVisible: Boolean(
        document.querySelector('[data-testid="sidebar-primary-navigation"]')?.checkVisibility(),
      ),
      automationsSelected: document
        .querySelector('[data-testid="automations-open"]')
        ?.getAttribute("aria-pressed"),
      pluginStoreSelected: document
        .querySelector('[data-testid="plugin-store-sidebar-open"]')
        ?.getAttribute("aria-pressed"),
      pluginStoreVisible: Boolean(
        document.querySelector('[data-testid="plugin-store-root"]')?.checkVisibility(),
      ),
    };
  });
}

async function saveEvidence(name: string, status: "passed" | "failed", error?: unknown) {
  const screenshot = join(evidenceDirectory, `${name}.png`);
  const state = join(evidenceDirectory, `${name}.json`);
  await rejectLinks(screenshot);
  await rejectLinks(state);
  let snapshot: Awaited<ReturnType<typeof readSnapshot>> | undefined;
  let captureError: string | undefined;
  try {
    snapshot = await readSnapshot();
    await browser.saveScreenshot(screenshot);
  } catch (failure) {
    captureError = failure instanceof Error ? failure.message : String(failure);
  }
  await writeFile(
    state,
    `${JSON.stringify({ case: name, status, error: error instanceof Error ? error.message : error === undefined ? undefined : String(error), captureError, snapshot }, null, 2)}\n`,
    "utf8",
  );
  if (captureError && status === "passed")
    throw new Error(`QA evidence capture failed: ${captureError}`);
}

async function withEvidence(name: string, action: () => Promise<void>) {
  try {
    await action();
    await saveEvidence(name, "passed");
  } catch (error) {
    await saveEvidence(name, "failed", error);
    throw error;
  }
}

async function clickSelector(selector: string) {
  const element = $(selector);
  await element.waitForDisplayed({ timeout: 15000 });
  await element.scrollIntoView({ block: "center" });
  await element.waitForClickable({ timeout: 15000 });
  await element.click();
}

async function openSettings() {
  if (!(await $('[data-testid="settings-page"]').isDisplayed())) {
    await clickSelector(`[data-testid="${TID_TASK_SETTINGS_BUTTON}"]`);
  }
  await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed({ timeout: 15000 });
}

async function navigateAndAssert(entry: SettingsCase) {
  await openSettings();
  const selector = `[data-testid="${testId(TID_SETTINGS_SECTION_NAV, entry.id)}"]`;
  await clickSelector(selector);
  await browser.waitUntil(async () => (await $(selector).getAttribute("aria-current")) === "page", {
    timeout: 15000,
    timeoutMsg: `QSM navigation did not select ${entry.id}`,
  });
  await browser.waitUntil(
    async () => {
      const snapshot = await readSnapshot();
      return snapshot.headings.some((heading) => entry.title.test(heading));
    },
    { timeout: 15000, timeoutMsg: `QSM content heading did not match ${entry.id}` },
  );
  await browser.waitUntil(
    async () =>
      browser.execute(
        (selectors, source) => {
          const main = document.querySelector('[data-testid="settings-page"] main');
          if (!main) return false;
          const hasControl = selectors.some((selector) =>
            Array.from(main.querySelectorAll(selector)).some((element) =>
              element.checkVisibility(),
            ),
          );
          return (
            hasControl && (!source || new RegExp(source, "u").test((main as HTMLElement).innerText))
          );
        },
        entry.selectors,
        entry.content?.source,
      ),
    { timeout: 15000, timeoutMsg: `QSM key control/empty state did not appear for ${entry.id}` },
  );
}

async function chooseLocale(locale: "zh-CN" | "en-US") {
  await navigateAndAssert(SETTINGS_CASES[0]!);
  await clickSelector(`[data-testid="${TID_SETTINGS_LOCALE_SELECT_TRIGGER}"]`);
  await clickSelector(`[data-testid="${testId(TID_SETTINGS_LOCALE_SELECT_ITEM, locale)}"]`);
  await browser.waitUntil(
    async () =>
      (await $('[data-settings-section-nav="general"]').getText()) ===
      (locale === "zh-CN" ? "常规" : "General"),
    { timeout: 15000, timeoutMsg: "QSM locale selection did not update the settings menu" },
  );
}

async function chooseTheme(theme: "zai-light" | "zai-dark") {
  await navigateAndAssert(SETTINGS_CASES[1]!);
  await clickSelector('[data-testid="settings-page"] main [role="combobox"]');
  const options = await $$('[role="option"]');
  const expected = theme === "zai-light" ? /浅色|Light/u : /深色|Dark/u;
  let selected = false;
  for (const option of options) {
    if ((await option.isDisplayed()) && expected.test(await option.getText())) {
      await option.waitForClickable({ timeout: 15000 });
      await option.click();
      selected = true;
      break;
    }
  }
  if (!selected) throw new Error(`QSM theme option unavailable: ${theme}`);
  await browser.waitUntil(
    async () =>
      browser.execute(
        (nextTheme) => document.documentElement.classList.contains(`theme-${nextTheme}`),
        theme,
      ),
    { timeout: 15000, timeoutMsg: "QSM theme did not converge after real select interaction" },
  );
}

describe("QSM 本轮外置 pending 设置菜单专项", () => {
  before(async () => {
    await prepareEvidenceDirectory();
    // 全局设置测试不依赖固定项目行；本轮既有夹具未播种该行，不能让项目前置阻断菜单验证。
    await skipOccupationOnboardingIfPresent();
    await $(`[data-testid="${TID_TASK_SETTINGS_BUTTON}"]`).waitForDisplayed({ timeout: 30000 });
    await prepareV4ConversationE2E({ skipProvider: true, skipShellReady: true });
    await setCurrentElectronRendererContentSize(1280, 900);
  });

  for (const [index, entry] of SETTINGS_CASES.entries()) {
    it(`QSM${String(index + 1).padStart(2, "0")}: 真实进入 ${entry.id} 并验证标题与内容`, async () => {
      await withEvidence(`QSM${String(index + 1).padStart(2, "0")}-${entry.id}`, async () => {
        await navigateAndAssert(entry);
      });
    });
  }

  it("QSM19: 当前桌面18个菜单存在且历史隐藏入口不出现", async () => {
    await withEvidence("QSM19-hidden-sections", async () => {
      await openSettings();
      const actual = (await readSnapshot()).navigation
        .filter((entry) => entry.visible)
        .map((entry) => entry.id);
      expect(actual).toHaveLength(18);
      expect([...actual].sort()).toEqual(SETTINGS_CASES.map((entry) => entry.id).sort());
      for (const hidden of HIDDEN_SECTIONS) expect(actual).not.toContain(hidden);
    });
  });

  let combinationIndex = 20;
  for (const theme of ["zai-light", "zai-dark"] as const) {
    for (const locale of ["zh-CN", "en-US"] as const) {
      const caseId = `QSM${combinationIndex++}-${theme}-${locale}`;
      it(`${caseId}: 实际选择主题/语言并检查设置及主导航`, async function () {
        this.timeout(180000);
        await withEvidence(caseId, async () => {
          await chooseLocale(locale);
          await chooseTheme(theme);
          for (const entry of SETTINGS_CASES) {
            await navigateAndAssert(entry);
            await saveEvidence(`${caseId}-${entry.id}`, "passed");
          }
          await clickSelector(`[data-testid="${TID_SETTINGS_BACK_BUTTON}"]`);
          await $('[data-testid="sidebar-primary-navigation"]').waitForDisplayed({
            timeout: 15000,
          });
          await clickSelector(`[data-testid="${TID_AUTOMATIONS_OPEN}"]`);
          await browser.waitUntil(
            async () =>
              (await $(`[data-testid="${TID_AUTOMATIONS_OPEN}"]`).getAttribute("aria-pressed")) ===
              "true",
            { timeout: 15000, timeoutMsg: "QSM automations main navigation was not selected" },
          );
          await browser.waitUntil(
            async () =>
              browser.execute(() =>
                Array.from(
                  document.querySelectorAll<HTMLElement>(
                    'h1,[data-testid="automations-page-tab-automation"]',
                  ),
                ).some(
                  (element) =>
                    element.checkVisibility() &&
                    /^(自动化|Automations)$/u.test(element.innerText.trim()),
                ),
              ),
            { timeout: 15000, timeoutMsg: "QSM automations content heading did not appear" },
          );
          await saveEvidence(`${caseId}-automations`, "passed");
          await clickSelector('[data-testid="plugin-store-sidebar-open"]');
          await $('[data-testid="plugin-store-root"]').waitForDisplayed({ timeout: 15000 });
          expect(
            await $('[data-testid="plugin-store-sidebar-open"]').getAttribute("aria-pressed"),
          ).toBe("true");
          expect(
            await $(`[data-testid="${TID_AUTOMATIONS_OPEN}"]`).getAttribute("aria-pressed"),
          ).toBe("false");
          await saveEvidence(`${caseId}-plugin-store`, "passed");
          // 中文说明：新任务按钮的 testid 在 group 上，真正点击主按钮以避免测试把容器当交互。
          await clickSelector(`[data-testid="${TID_TASK_NEW_BUTTON}"] button`);
          await browser.waitUntil(
            async () =>
              (await $('[data-testid="plugin-store-sidebar-open"]').getAttribute(
                "aria-pressed",
              )) === "false",
            { timeout: 15000, timeoutMsg: "QSM new task did not leave plugin store" },
          );
          await $(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`).waitForDisplayed({
            timeout: 15000,
          });
        });
      });
    }
  }
});
