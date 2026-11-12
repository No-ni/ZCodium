import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import {
  nativeContextConfigurationSchema,
  type NativeContextObservation,
  type NativeContextStatus,
} from "@zcode/shared/native-context-compression";
import { TID_TASK_ITEM, TID_V4_SESSION_PANE, testId } from "@zcode/shared/test-ids";
import { DEFAULT_WORKSPACE } from "../desktop-app.js";
import { openMobilePairingPage } from "../mobile-pairing.js";
import { showMobileTaskHome, waitMobileTaskView } from "../web-remote-unread.js";
import { assertNativeContextTestPath } from "./environment.js";
import { prepareNativeContextMobileOnboarding } from "./mobile-onboarding.js";
import { recordNativeContextMobileEvidence } from "./mobile-evidence.js";
import { obtainNativeContextPairingUrl } from "./mobile-pairing-admission.js";

interface LocalVisibilityPage extends Page {
  _connection?: {
    toImpl?(page: Page): {
      delegate?: {
        _mainFrameSession?: {
          _client?: { send(method: string, params: { enabled: boolean }): Promise<void> };
        };
      };
    };
  };
}

async function useNativeTabVisibility(page: Page) {
  // 既有可见性回归已确认 Playwright 在原 CDP session 强制 focus；只撤销该测试覆盖，
  // 后续使用真实 Chrome tab 切换，不伪造 document.visibilityState 或业务恢复事件。
  const client = (page as LocalVisibilityPage)._connection?.toImpl?.(page)?.delegate
    ?._mainFrameSession?._client;
  if (typeof client?.send !== "function")
    throw new Error("NCTX native Chromium visibility ABI unavailable");
  await client.send("Emulation.setFocusEmulationEnabled", { enabled: false });
}

export interface NativeContextMobileBrowser {
  context: BrowserContext;
  page: Page;
  openTask(taskId: string): Promise<void>;
  hide(): Promise<void>;
  show(): Promise<void>;
  screenshot(name: string): Promise<void>;
  close(): Promise<void>;
}

/** 整个 suite 只调用一次；profile/cache/downloads/Chromium 子进程环境显式留在工作树。 */
export async function createNativeContextMobileBrowser(
  evidenceDirectory: string,
): Promise<NativeContextMobileBrowser> {
  const profile = await assertNativeContextTestPath(join(evidenceDirectory, "mobile-profile"));
  const downloads = await assertNativeContextTestPath(join(profile, "downloads"));
  const cache = await assertNativeContextTestPath(join(profile, "cache"));
  const diagnostics = await assertNativeContextTestPath(join(evidenceDirectory, "mobile"));
  await Promise.all(
    [profile, downloads, cache, diagnostics].map((path) => mkdir(path, { recursive: true })),
  );
  await Promise.all([profile, downloads, cache, diagnostics].map(assertNativeContextTestPath));
  const origin = process.env.ZCODIUM_E2E_MOBILE_URL?.trim();
  if (!origin || new URL(origin).hostname !== "127.0.0.1")
    throw new Error("NCTX requires the existing project-only mobile fixture origin");
  const pairingUrl = await obtainNativeContextPairingUrl(new URL(origin).origin, diagnostics);
  const executablePath =
    process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE || process.env.R3_MOBILE_CHROME;
  const context = await chromium.launchPersistentContext(profile, {
    ...(executablePath ? { executablePath } : { channel: "chrome" }),
    headless: false,
    viewport: { width: 390, height: 844 },
    locale: "zh-CN",
    isMobile: true,
    hasTouch: true,
    downloadsPath: downloads,
    env: { ...process.env },
    args: [`--disk-cache-dir=${cache}`, `--crash-dumps-dir=${diagnostics}`],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(30_000);
  try {
    await openMobilePairingPage(page, pairingUrl, {
      artifactDir: diagnostics,
      caseMarker: "NCTX-mobile",
      phase: "shared-host-admission",
      readySelector: '[data-testid="sidebar"], [data-mobile-page="chat"]',
    });
    await useNativeTabVisibility(page);
    await page.bringToFront();
    await page.waitForFunction(() => document.visibilityState === "visible");
    const preflight = await prepareNativeContextMobileOnboarding(page, (stage) =>
      recordNativeContextMobileEvidence(page, diagnostics, stage),
    );
    await appendFile(
      join(diagnostics, "native-stages.jsonl"),
      JSON.stringify({ stage: "onboarding-preflight", ...preflight }) + "\n",
    );
  } catch (error) {
    const failures = [error];
    try {
      await recordNativeContextMobileEvidence(page, diagnostics, "admission-failed");
    } catch {
      // 原因：旧空 catch 隐藏了采集失败；保留首个 admission 错误并追加安全 code，不记录原文。
      failures.push(new Error("NCTX_MOBILE_EVIDENCE_WRITE_FAILED"));
    }
    try {
      await context.close();
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    if (failures.length > 1)
      throw new AggregateError(failures, "NCTX mobile admission, evidence or cleanup failed");
    throw error;
  }
  let cover: Page | undefined;
  const record = async (stage: string) =>
    appendFile(
      join(diagnostics, "native-stages.jsonl"),
      JSON.stringify({ stage, visibility: await page.evaluate(() => document.visibilityState) }) +
        "\n",
    );
  return {
    context,
    page,
    async openTask(taskId) {
      let stage:
        | "task-home"
        | "task-chat"
        | "task-session"
        | "task-main-view"
        | "task-native-entry" = "task-home";
      try {
        await page.bringToFront();
        await page.waitForFunction(() => document.visibilityState === "visible");
        await closeNativeContextMobileDetails(page);
        await showMobileTaskHome(page);
        await page.getByTestId(testId(TID_TASK_ITEM, taskId)).click();
        stage = "task-chat";
        await page.locator('[data-mobile-page="chat"]').waitFor();
        const pane = page.getByTestId(testId(TID_V4_SESSION_PANE, "workspace-main"));
        await pane.waitFor();
        stage = "task-session";
        // pane 壳会在任务恢复前出现；必须等共享 SessionPane 的真实 session 身份。
        await page.waitForFunction(
          ({ id, session }) =>
            document.querySelector(`[data-testid="${id}"]`)?.getAttribute("data-session-id") ===
            session,
          { id: testId(TID_V4_SESSION_PANE, "workspace-main"), session: taskId },
        );
        stage = "task-main-view";
        await waitMobileTaskView({ taskId, workspacePath: DEFAULT_WORKSPACE });
        stage = "task-native-entry";
        await page.getByTestId("native-context-entry").waitFor();
        await recordNativeContextMobileEvidence(page, diagnostics, "task-open", taskId);
        await record("task-open");
      } catch (error) {
        try {
          await recordNativeContextMobileEvidence(page, diagnostics, `${stage}-failed`, taskId);
        } catch {
          throw new AggregateError(
            [error, new Error("NCTX_MOBILE_EVIDENCE_WRITE_FAILED")],
            "NCTX mobile task admission and evidence failed",
          );
        }
        throw error;
      }
    },
    async hide() {
      cover ??= await context.newPage();
      await useNativeTabVisibility(cover);
      await cover.bringToFront();
      await page.waitForFunction(() => document.visibilityState === "hidden");
      await waitMobileTaskView(null);
      await record("background");
    },
    async show() {
      await page.bringToFront();
      await page.waitForFunction(() => document.visibilityState === "visible");
      await record("foreground");
    },
    async screenshot(name) {
      const path = await assertNativeContextTestPath(join(diagnostics, name));
      await page.screenshot({ path, fullPage: true });
    },
    async close() {
      await context.close();
    },
  };
}

/** 同一 Page 的导航和失败清理复用原关闭入口，等待实际隐藏后再操作背景导航。 */
export async function closeNativeContextMobileDetails(page: Page) {
  const details = page.getByTestId("native-context-details");
  if (await details.isVisible()) {
    await details.locator('[data-slot="dialog-close"]').click();
    await details.waitFor({ state: "hidden", timeout: 10000 });
  }
  const popover = page.getByTestId("native-context-popover");
  if (await popover.isVisible()) {
    await page.keyboard.press("Escape");
    await popover.waitFor({ state: "hidden", timeout: 10000 });
  }
}

export async function openNativeContextMobileDetails(
  page: Page,
  tab: "parameters" | "trends" | "records" = "parameters",
) {
  if (!(await page.getByTestId("native-context-details").isVisible())) {
    if (!(await page.getByTestId("native-context-popover").isVisible()))
      await page.getByTestId("native-context-entry").click();
    await page
      .getByTestId(
        tab === "parameters" ? "native-context-open-parameters" : "native-context-open-trends",
      )
      .click();
    await page.getByTestId("native-context-details").waitFor();
  }
  await page.getByTestId(`native-context-tab-${tab}`).click();
}

/** 对账真实手机参数投影，不能仅依赖桌面 query 或共享组件单测。 */
export async function assertNativeContextMobileConfiguration(
  page: Page,
  status: NativeContextStatus,
) {
  await openNativeContextMobileDetails(page);
  const editor = page.getByTestId("native-context-complete-editor");
  if ((await editor.getAttribute("open")) === null) await editor.locator("summary").click();
  await page.waitForFunction((version) => {
    return (
      document
        .querySelector('[data-testid="native-context-parameter-save-status"]')
        ?.getAttribute("data-version") === String(version)
    );
  }, status.policy.policyVersion);
  const configuration = nativeContextConfigurationSchema.parse(
    JSON.parse(await page.getByTestId("native-context-configuration-json").inputValue()),
  );
  expect(configuration).toEqual({
    schemaVersion: 1,
    mode: status.policy.mode,
    parameters: status.policy.parameters,
  });
}

export async function assertNativeContextMobileObservation(
  page: Page,
  observation: NativeContextObservation,
) {
  await openNativeContextMobileDetails(page, "trends");
  await page.getByTestId("native-context-trend-request").click();
  await page
    .getByRole("option")
    .filter({ hasText: `#${observation.requestSeq} ·` })
    .click();
  await page.waitForFunction(
    (id) =>
      document
        .querySelector('[data-testid="native-context-request-details"]')
        ?.getAttribute("data-observation-id") === id,
    observation.id,
  );
  const actual = await page.getByTestId("native-context-request-metric-actualInput").textContent();
  expect(actual?.replace(/[^0-9]/gu, "")).toBe(String(observation.actualInputTokens));
  const counts = await Promise.all(
    ["input", "cache", "image"].map((chart) =>
      page.getByTestId(`native-context-${chart}-chart`).getAttribute("data-request-count"),
    ),
  );
  expect(new Set(counts).size).toBe(1);
  expect(Number(counts[0])).toBeGreaterThan(0);
}
