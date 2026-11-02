import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { startProjectBrowserFixture } from "./project-browser-fixture.mjs";
import { assertProjectPath } from "./project-test-sandbox.mjs";
test(
  "local errors retain detail/copy/retry/feedback in both languages and widths",
  { timeout: 120000 },
  async () => {
    const fixture = await startProjectBrowserFixture({
      label: "official317-local-errors",
      entry: "scripts/ci/fixtures/session-local-errors.html",
    });
    let context, page;
    const errors = [],
      requests = [];
    try {
      const { chromium } = await import("playwright-core");
      const downloadsPath = await assertProjectPath(join(fixture.sandbox.root, "downloads"));
      await mkdir(downloadsPath);
      context = await chromium.launchPersistentContext(
        await assertProjectPath(join(fixture.sandbox.root, "profile")),
        {
          executablePath: await assertProjectPath(process.env.PROJECT_TEST_BROWSER_EXECUTABLE),
          headless: true,
          env: fixture.sandbox.env,
          downloadsPath,
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
      page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.on("pageerror", (error) => errors.push(error.message));
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (
          ["data:", "blob:", "about:"].includes(url.protocol) ||
          url.origin === new URL(fixture.origin).origin
        )
          await route.continue();
        else {
          requests.push(url.origin);
          await route.abort();
        }
      });
      for (const locale of ["en-US", "zh-CN"])
        for (const width of [390, 1280]) {
          await page.setViewportSize({ width, height: 900 });
          for (const code of ["1005", "1006", "3008", "3010", "1308", "429"]) {
            await page.goto(
              `${fixture.url}?locale=${locale}&code=${code}&theme=${width === 1280 ? "dark" : "light"}`,
            );
            const summary = page.getByText("Fixture provider limit reached", { exact: true });
            await summary.waitFor({ state: "attached" });
            const bounds = await summary.boundingBox();
            assert.ok(
              bounds && bounds.width > 100 && bounds.height > 0,
              `Error summary must remain readable at ${width}px: ${JSON.stringify(bounds)}`,
            );
            const banner = page.locator('[data-testid="chat-error-banner"]');
            assert.equal(await banner.getByText(/登录|套餐|升级|sign in|plan|upgrade/i).count(), 0);
            const mcp = page.getByRole("region", { name: "MCP tool result" });
            await mcp.getByText("Fixture MCP connection failed", { exact: true }).waitFor();
            assert.equal(await mcp.getByText(/Coding Plan|套餐/i).count(), 0);
            if (code !== "1005") continue;
            await banner.locator('[data-testid="chat-error-details-button"]').press("Enter");
            const dialog = page.getByRole("dialog");
            await dialog.getByText("Fixture safe error detail", { exact: true }).waitFor();
            await page.keyboard.press("Escape");
            await dialog.waitFor({ state: "hidden" });
            await banner
              .getByRole("button", {
                name: locale === "en-US" ? "Copy" : "复制",
                exact: true,
              })
              .click();
            await page.waitForFunction(() => window.errorFixture.copies.length === 1);
            const copied = await page.evaluate(() => window.errorFixture.copies[0]);
            for (const value of [
              "Fixture provider limit reached",
              "Fixture safe error detail",
              "local-fixture-trace",
            ])
              assert.ok(copied.includes(value));
            await banner
              .getByRole("button", { name: locale === "en-US" ? "Retry" : "重试", exact: true })
              .click();
            assert.equal(await page.evaluate(() => window.errorFixture.retries), 1);
            await banner
              .getByRole("button", {
                name: locale === "en-US" ? "Report issue" : "反馈问题",
                exact: true,
              })
              .click();
            assert.equal(await page.evaluate(() => window.errorFixture.diagnostics), 1);
            assert.equal(
              await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
              true,
            );
            await page.screenshot({
              animations: "disabled",
              path: await assertProjectPath(
                join(fixture.sandbox.root, `session-errors-${locale}-${width}.png`),
              ),
              fullPage: true,
            });
            await banner
              .getByRole("button", {
                name: locale === "en-US" ? "Dismiss error" : "关闭错误提示",
                exact: true,
              })
              .click();
            await banner.waitFor({ state: "hidden" });
            await mcp.getByText("Fixture MCP connection failed", { exact: true }).waitFor();
          }
        }
      assert.deepEqual(errors, []);
      assert.deepEqual(requests, []);
      console.log(`Local error browser evidence: ${fixture.sandbox.root}`);
    } catch (error) {
      console.log("Local error browser errors:", errors);
      await page?.screenshot({
        animations: "disabled",
        path: await assertProjectPath(join(fixture.sandbox.root, "failure.png")),
        fullPage: true,
      });
      throw error;
    } finally {
      await context?.close();
      await fixture.close();
    }
  },
);
