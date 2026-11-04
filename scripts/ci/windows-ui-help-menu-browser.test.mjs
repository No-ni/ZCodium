import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { startProjectBrowserFixture } from "./project-browser-fixture.mjs";
import { assertProjectPath } from "./project-test-sandbox.mjs";

for (const configured of [false, true]) {
  test(
    `WINUI15–16 help menu: own update source ${configured ? "configured" : "absent"}`,
    { timeout: 150000 },
    async () => {
      const fixture = await startProjectBrowserFixture({
        label: "winui-help-menu",
        entry: "scripts/ci/fixtures/windows-ui-regressions.html",
        productFlavor: "production",
        updateOrigin: configured ? "https://example.invalid" : "",
        optimizeDepsInclude: [
          "qrcode",
          "border-beam",
          "ansi-to-react",
          "react-jsx-parser",
          "react-pdf",
        ],
      });
      let context;
      const errors = [],
        external = [];
      try {
        const { chromium } = await import("playwright-core");
        const downloads = await assertProjectPath(join(fixture.sandbox.root, "downloads"));
        await mkdir(downloads);
        context = await chromium.launchPersistentContext(
          await assertProjectPath(join(fixture.sandbox.root, "profile")),
          {
            executablePath: await assertProjectPath(process.env.PROJECT_TEST_BROWSER_EXECUTABLE),
            env: fixture.sandbox.env,
            headless: true,
            downloadsPath: downloads,
            args: [
              "--disable-background-networking",
              "--disable-component-update",
              "--disable-sync",
              "--disable-breakpad",
              "--no-first-run",
              "--no-default-browser-check",
            ],
          },
        );
        context.setDefaultTimeout(15000);
        await context.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (
            ["data:", "blob:", "about:"].includes(url.protocol) ||
            url.origin === new URL(fixture.origin).origin
          )
            await route.continue();
          else {
            external.push(url.origin);
            await route.abort();
          }
        });
        const page = await context.newPage();
        page.on("pageerror", (error) => errors.push(error.message));
        for (const platform of ["windows", "mac", "web"]) {
          for (const view of ["help-menu", "settings"]) {
            await page.goto(`${fixture.url}?view=${view}&platform=${platform}&locale=en-US`);
            if (view === "settings") {
              await page.getByTestId("settings-section-nav-general").click();
              for (const label of [
                "Receive preview updates early",
                "Automatically download and install updates",
              ]) {
                assert.equal(
                  await page.getByRole("switch", { name: label, exact: true }).count(),
                  Number(configured && platform !== "web"),
                );
              }
            }
            await page.getByRole("button", { name: "Help", exact: true }).click();
            assert.equal(
              await page.getByRole("menuitem", { name: "Check for updates", exact: true }).count(),
              Number(configured && platform !== "web"),
            );
            assert.equal(
              await page.getByRole("menuitem", { name: "Product docs", exact: true }).count(),
              1,
            );
            await page.keyboard.press("Escape");
          }
        }
        for (const locale of ["en-US", "zh-CN"]) {
          await page.goto(`${fixture.url}?view=help-menu&platform=windows&locale=${locale}`);
          const trigger = page.getByRole("button", {
            name: locale === "en-US" ? "Help" : "帮助",
            exact: true,
          });
          await trigger.waitFor();
          if (configured) {
            await page.evaluate(() =>
              window.fixture.emitHelpUpdate({ kind: "checking", enabled: false }),
            );
            await trigger.click();
            const checking = page.getByRole("menuitem", {
              name: locale === "en-US" ? "Checking for updates..." : "正在检查更新...",
              exact: true,
            });
            await checking.waitFor();
            await page.evaluate(async () => {
              window.fixture.releaseHelpUpdateRead({ kind: "idle", enabled: true });
              await new Promise(requestAnimationFrame);
              await new Promise(requestAnimationFrame);
            });
            assert.equal(await checking.getAttribute("data-disabled"), "");
            await page.evaluate(() =>
              window.fixture.emitHelpUpdate({ kind: "idle", enabled: true }),
            );
            await page.keyboard.press("Escape");
          }
          const labels =
            locale === "en-US"
              ? [
                  "Product docs",
                  "User community",
                  "Report an issue",
                  "Resource manager",
                  "About ZCodium",
                  ...(configured ? ["Check for updates"] : []),
                ]
              : [
                  "产品文档",
                  "用户社群",
                  "问题上报",
                  "资源管理器",
                  "关于 ZCodium",
                  ...(configured ? ["检查更新"] : []),
                ];
          for (const label of labels) {
            await page.evaluate(() => window.fixture.setHelpFailure(true));
            await trigger.click();
            await page.getByRole("menuitem", { name: label, exact: true }).click();
            await page
              .getByText(
                locale === "en-US"
                  ? "Could not complete this action. Please try again."
                  : "操作失败，请重试。",
                { exact: true },
              )
              .first()
              .waitFor();
            const beforeRetry = await page.evaluate(() => window.fixtureCalls.helpActions.length);
            await page.evaluate(() => window.fixture.setHelpFailure(false));
            await trigger.click();
            await page.getByRole("menuitem", { name: label, exact: true }).click();
            await page.waitForFunction(
              (before) => window.fixtureCalls.helpActions.length === before + 1,
              beforeRetry,
            );
          }
          await page.screenshot({
            path: await assertProjectPath(join(fixture.sandbox.root, `${locale}-help-failure.png`)),
            fullPage: true,
          });
        }
        assert.deepEqual(errors, []);
        assert.deepEqual(external, []);
        console.log(`WINUI15–16 evidence: ${fixture.sandbox.root}`);
      } finally {
        await context?.close();
        await fixture.close();
      }
    },
  );
}
