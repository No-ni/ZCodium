import { registerShareDisclosureTests } from "./share-disclosure-feedback.mjs";
import { registerShareBoundaryTests } from "./share-selection-boundaries.mjs";
import assert from "node:assert/strict";
import { verifySelectionSelectAll } from "./share-selection-all.mjs";
import { verifySelectionScrollMask } from "./share-selection-mask.mjs";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";
import {
  createProjectTestSandbox,
  assertProjectPath,
} from "../../../../../../scripts/ci/project-test-sandbox.mjs";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/share-popover.fixture.tsx";
let artifacts, sandbox, server, browser, origin;
registerShareBoundaryTests(() => ({ browser, origin, artifacts }));
registerShareDisclosureTests(() => ({ browser, origin, artifacts }));
before(async () => {
  // 旧 setup 依赖 system chrome channel 与默认 Vite cache，会在隔离 permission 下写到工作树外；改为全部落在项目测试 sandbox 内。
  sandbox = await createProjectTestSandbox("share-popover");
  artifacts = join(sandbox.root, "artifacts");
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    cacheDir: join(sandbox.root, "vite-cache"),
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "share-selection-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  browser = await chromium.launch({
    executablePath: await assertProjectPath(process.env.PROJECT_TEST_BROWSER_EXECUTABLE),
    headless: true,
    env: sandbox.env,
    args: [
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-breakpad",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
  // 预加载 fixture 预热 Vite 转换，避免正式测试的冷导航超过导航超时；UI 就绪后关闭 warm page，再正式测试。
  const warmPage = await browser.newPage();
  await warmPage.goto(`${origin}fixture?theme=light&locale=zh-CN`, {
    waitUntil: "domcontentloaded",
  });
  await warmPage.getByTestId("conversation-share-trigger").waitFor({ timeout: 120000 });
  await warmPage.close();
});
after(async () => {
  await browser?.close();
  await server?.close();
});

for (const width of [390, 1200])
  for (const theme of ["light", "dark"])
    for (const locale of ["zh-CN", "en-US"])
      test(`SHARE34 ${width} ${theme} ${locale}`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        page.setDefaultTimeout(5000);
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        await page.goto(`${origin}fixture?theme=${theme}&locale=${locale}`);
        const popover = page.getByTestId("conversation-share-popover");
        const panel = page.getByTestId("conversation-share-selection-panel");
        await page.getByTestId("conversation-share-trigger").click();
        await popover.waitFor();
        await page.evaluate(async () => {
          await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})));
        });
        const scopeButton = page.getByTestId("conversation-share-adjust");
        const normalBounds = await popover.boundingBox();
        await page.getByTestId("conversation-share-confirm").click();
        const disclosure = page.getByTestId("conversation-share-disclosure");
        const reviewCheckbox = page.getByTestId("conversation-share-disclosure-checkbox");
        assert.equal(await reviewCheckbox.getAttribute("aria-invalid"), "true");
        assert.equal(await disclosure.evaluate((node) => node.getAnimations().length), 0);
        assert.equal(await page.getByTestId("conversation-share-publish-progress").count(), 0);
        assert.deepEqual(await popover.boundingBox(), normalBounds);
        await reviewCheckbox.check();
        assert.equal(await reviewCheckbox.getAttribute("aria-invalid"), "false");
        assert.equal(await page.getByTestId("conversation-share-publish-progress").count(), 0);
        await reviewCheckbox.uncheck();
        await page.getByTestId("conversation-share-confirm").click();
        await popover.screenshot({
          path: join(artifacts, `${width}-${theme}-${locale}-unchecked.png`),
        });
        await page.getByTestId("conversation-share-disclosure-scope-trigger").click();
        const reviewScope = page.getByTestId("conversation-share-disclosure-scope-content");
        await reviewScope.waitFor();
        await page.evaluate(async () => {
          await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})));
        });
        await reviewScope.screenshot({
          path: join(artifacts, `${width}-${theme}-${locale}-scope.png`),
        });
        const reviewBounds = await reviewScope.boundingBox();
        assert.ok(reviewBounds.x >= 0 && reviewBounds.x + reviewBounds.width <= width + 1);
        assert.ok(reviewBounds.y >= 0 && reviewBounds.y + reviewBounds.height <= 901);
        await page.keyboard.press("Escape");
        await reviewScope.waitFor({ state: "hidden" });
        assert.equal(await popover.isVisible(), true);
        // combobox 已随云分享 UI 退休；改为校验标题输入框与范围按钮均落在 popover 水平边界内。
        const popoverBounds = await popover.boundingBox();
        const titleInputBox = await popover.getByRole("textbox").boundingBox();
        const rangeButtonBox = await scopeButton.boundingBox();
        for (const box of [titleInputBox, rangeButtonBox]) {
          assert.ok(box.width > 0);
          assert.ok(box.x >= popoverBounds.x - 1);
          assert.ok(box.x + box.width <= popoverBounds.x + popoverBounds.width + 1);
        }
        await page.getByTestId("toggle-preflight").click();
        assert.equal(await scopeButton.getAttribute("aria-busy"), "true");
        assert.match(
          await scopeButton.innerText(),
          locale === "zh-CN" ? /正在检查分享内容/ : /checking/i,
        );
        assert.equal(
          await page.getByTestId("conversation-share-selection-preflight-status").count(),
          0,
        );
        assert.equal((await popover.boundingBox()).height, normalBounds.height);
        await page.getByTestId("toggle-preflight").click();
        assert.equal(await scopeButton.getAttribute("aria-busy"), "false");
        await page.getByTestId("conversation-share-adjust").click();
        await panel.waitFor();
        await page.evaluate(async () => {
          await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})));
        });
        const rows = panel.locator("[data-conversation-share-selection-item]");
        const previews = rows.getByTestId("conversation-share-selection-toggle");
        const firstTitle = previews.nth(0).locator("span").first();
        const secondTitle = previews.nth(1).locator("span").first();
        assert.equal((await firstTitle.boundingBox()).x, (await secondTitle.boundingBox()).x);
        const titleRect = await firstTitle.boundingBox();
        const checkRect = await rows.nth(0).getByRole("checkbox").boundingBox();
        const firstMessage = previews.nth(0).locator("span").last();
        const messageRect = await firstMessage.boundingBox();
        assert.equal(messageRect.x, titleRect.x);
        assert.equal((await panel.boundingBox()).width, Math.min(320, width - 16));
        assert.equal(messageRect.height, 32);
        assert.ok(
          await firstMessage.evaluate(
            (node) =>
              node.scrollHeight > node.clientHeight &&
              getComputedStyle(node).webkitLineClamp === "2",
          ),
        );
        assert.ok(
          Math.abs(checkRect.y + checkRect.height / 2 - titleRect.y - titleRect.height / 2) < 1,
        );
        assert.deepEqual(
          await firstTitle.evaluate((node) => ({
            size: getComputedStyle(node).fontSize,
            weight: getComputedStyle(node).fontWeight,
          })),
          { size: "14px", weight: "400" },
        );
        assert.equal(
          await firstMessage.evaluate((node) => getComputedStyle(node).fontSize),
          "12px",
        );
        assert.equal(
          (await page.getByTestId("conversation-share-selection-apply").boundingBox()).height,
          32,
        );
        assert.equal(
          (await page.getByTestId("conversation-share-selection-cancel").boundingBox()).height,
          32,
        );
        await panel.screenshot({
          path: join(artifacts, `${width}-${theme}-${locale}-selector.png`),
        });
        await verifySelectionScrollMask(
          panel,
          join(artifacts, `${width}-${theme}-${locale}-mask.png`),
        );
        await verifySelectionSelectAll(panel);
        const checkbox = rows.first().getByRole("checkbox");
        await checkbox.click();
        assert.match(await page.getByTestId("conversation-share-range-summary").innerText(), /8/);
        assert.equal(await page.getByTestId("conversation-share-confirm").isDisabled(), true);
        await rows.first().getByTestId("conversation-share-selection-locate").click();
        assert.equal(await page.getByTestId("inspected").innerText(), "1");
        assert.equal(await panel.isVisible(), true);
        await page.getByTestId("conversation-share-selection-cancel").click();
        await panel.waitFor({ state: "hidden" });
        await page.getByTestId("conversation-share-adjust").click();
        await panel.waitFor();
        assert.equal(await checkbox.getAttribute("data-state"), "checked");
        await checkbox.click();
        await page.getByTestId("conversation-share-selection-apply").click();
        await panel.waitFor({ state: "hidden" });
        assert.match(await page.getByTestId("conversation-share-range-summary").innerText(), /7/);
        await page.getByTestId("conversation-share-adjust").click();
        await panel.waitFor();
        await page.keyboard.press("Escape");
        await panel.waitFor({ state: "hidden" });
        assert.equal(await popover.isVisible(), true);
        await page.keyboard.press("Escape");
        await popover.waitFor({ state: "hidden" });
        await page.getByTestId("conversation-share-trigger").click();
        await popover.waitFor();
        assert.match(await page.getByTestId("conversation-share-range-summary").innerText(), /7/);
        await page.evaluate(async () => {
          await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})));
        });
        await page.screenshot({ path: join(artifacts, `${width}-${theme}-${locale}.png`) });
        const bounds = await popover.boundingBox();
        await page.screenshot({
          path: join(artifacts, `${width}-${theme}-${locale}-popover.png`),
          clip: {
            x: Math.max(0, bounds.x - 8),
            y: Math.max(0, bounds.y - 8),
            width: bounds.width + 16,
            height: bounds.height + 16,
          },
        });
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
        await page.getByTestId("conversation-share-adjust").click();
        await panel.waitFor();
        await page.getByRole("textbox", { name: "Composer", exact: true }).click();
        await panel.waitFor({ state: "hidden" });
        assert.equal(await popover.isVisible(), true);
        await page.getByRole("textbox", { name: "Composer", exact: true }).click();
        await popover.waitFor({ state: "hidden" });
        await page.getByTestId("conversation-share-trigger").click();
        await popover.waitFor();
        await page.getByTestId("conversation-share-adjust").click();
        await panel.waitFor();
        assert.equal(await rows.last().getByRole("checkbox").isDisabled(), true);
        const checks = rows.getByRole("checkbox");
        for (let i = 0; i < 8; i++) {
          if ((await checks.nth(i).getAttribute("data-state")) === "checked")
            await checks.nth(i).click();
        }
        assert.equal(
          await page.getByTestId("conversation-share-selection-apply").isDisabled(),
          true,
        );
        await page.evaluate(async () => {
          await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})));
        });
        await page.screenshot({
          path: join(artifacts, `${width}-${theme}-${locale}-selection.png`),
        });
        const footer = await page.getByTestId("conversation-share-selection-footer").boundingBox();
        assert.ok(footer.y >= 0 && footer.y + footer.height <= 900);
        await page.getByTestId("conversation-share-selection-cancel").click();
        await panel.waitFor({ state: "hidden" });
        await popover.getByRole("checkbox").check();
        await page.getByTestId("conversation-share-confirm").click();
        await page.getByTestId("conversation-share-publish-progress").waitFor();
        assert.equal(await page.getByTestId("conversation-share-confirm").count(), 0);
        const readTypeSizes = () =>
          popover.evaluate((node) => {
            const size = (selector) => getComputedStyle(node.querySelector(selector)).fontSize;
            return {
              title: size('[data-testid="conversation-share-confirmation-header"] p'),
              task: size('[data-testid="conversation-share-publish-progress"] > p'),
              phase: size('[data-testid="conversation-share-publish-phase-collecting"] strong'),
              progress: size(
                '[data-testid="conversation-share-publish-phase-collecting"] strong + span',
              ),
              summary: size('[data-testid="conversation-share-confirmation-actions"] > p'),
            };
          });
        assert.deepEqual(await readTypeSizes(), {
          title: "16px",
          task: "14px",
          phase: "14px",
          progress: "14px",
          summary: "12px",
        });
        const progressIcon = page
          .getByTestId("conversation-share-publish-phase-collecting")
          .locator("svg");
        const iconSize = await progressIcon.evaluate((node) => getComputedStyle(node).width);
        await page.evaluate(() =>
          document.documentElement.style.setProperty("--ui-font-size", "18px"),
        );
        assert.deepEqual(await readTypeSizes(), {
          title: "20px",
          task: "18px",
          phase: "18px",
          progress: "18px",
          summary: "16px",
        });
        assert.equal(await progressIcon.evaluate((node) => getComputedStyle(node).width), iconSize);
        await page.evaluate(() => document.documentElement.style.removeProperty("--ui-font-size"));
        for (const phase of ["collecting", "packing", "saving"]) {
          if (phase !== "collecting") await page.getByTestId("advance-publish").click();
          assert.equal(
            await page
              .getByTestId(`conversation-share-publish-phase-${phase}`)
              .getAttribute("data-phase-state"),
            "active",
          );
          await popover.screenshot({
            path: join(artifacts, `${width}-${theme}-${locale}-${phase}.png`),
          });
        }
        await page.keyboard.press("Escape");
        assert.equal(await popover.isVisible(), true);
        assert.equal(await page.getByTestId("conversation-share-trigger").isDisabled(), true);
        await page.getByTestId("resolve-publish").click();
        await page.getByTestId("conversation-share-success-dock").waitFor();
        // 本地导出成功语义：只展示下载已开始状态与导出文件名，不出现云分享 URL、复制链接或浏览器打开入口。
        assert.match(
          await page.getByTestId("conversation-share-success-status").innerText(),
          locale === "zh-CN" ? /已开始下载/ : /download started/i,
        );
        const exportedName =
          "国内海外双区域登录与下载分发适配，以及长标题布局和多语言兼容性验证.md";
        assert.equal(
          await page
            .getByTestId("conversation-share-result-title")
            .evaluate((node) => node.textContent),
          exportedName,
        );
        assert.equal(await page.getByTestId("conversation-share-copy-link").count(), 0);
        assert.equal(await page.getByTestId("conversation-share-open-browser").count(), 0);
        assert.equal(await popover.getByRole("textbox").count(), 0);
        assert.equal(
          await page
            .getByTestId("conversation-share-result-title")
            .evaluate((node) => getComputedStyle(node).webkitLineClamp),
          "2",
        );
        assert.equal(await popover.isVisible(), true);
        await page.evaluate(async () => {
          await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})));
        });
        await page.screenshot({ path: join(artifacts, `${width}-${theme}-${locale}-success.png`) });
        await popover.screenshot({
          path: join(artifacts, `${width}-${theme}-${locale}-success-popover.png`),
        });
        await page.getByTestId("conversation-share-success-dismiss").click();
        await popover.waitFor({ state: "hidden" });
        await page.getByTestId("conversation-share-trigger").click();
        await popover.waitFor();
        assert.equal(await page.getByTestId("conversation-share-success-dock").count(), 0);
        assert.equal(await popover.getByRole("checkbox").isChecked(), false);
        assert.match(await page.getByTestId("conversation-share-range-summary").innerText(), /8/);
        await page.getByTestId("conversation-share-adjust").click();
        await panel.waitFor();
        await rows.first().getByRole("checkbox").click();
        await page.getByTestId("conversation-share-selection-apply").click();
        await panel.waitFor({ state: "hidden" });
        await popover.getByRole("checkbox").check();
        await page.getByTestId("conversation-share-confirm").click();
        await page.getByTestId("conversation-share-publish-progress").waitFor();
        await page.getByTestId("resolve-publish").click();
        await page.getByTestId("conversation-share-success-dock").waitFor();
        assert.deepEqual(errors, []);
        await page.close();
      });
