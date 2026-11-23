import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { startProjectBrowserFixture } from "./project-browser-fixture.mjs";

test(
  "actual vis timeline preserves selection, fullscreen cleanup and remount lifecycle",
  { timeout: 120000 },
  async () => {
    const fixture = await startProjectBrowserFixture({
      label: "remaining-debug-gantt",
      entry: "scripts/ci/fixtures/remaining-debug-presentation.html",
      tailwind: false,
      optimizeDepsInclude: ["vis-timeline/standalone"],
    });
    let context;
    const errors = [],
      external = [];
    try {
      const { chromium } = await import("playwright-core");
      context = await chromium.launchPersistentContext(fixture.sandbox.root + "/browser-profile", {
        executablePath: process.env.PROJECT_TEST_BROWSER_EXECUTABLE,
        headless: true,
        env: fixture.sandbox.env,
      });
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (
          ["about:", "data:", "blob:"].includes(url.protocol) ||
          url.origin === new URL(fixture.origin).origin
        )
          return route.continue();
        external.push(url.origin);
        await route.abort();
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(fixture.url);
      await page.locator(".vis-item-content").filter({ hasText: "Fixture Alpha" }).first().click();
      await page.getByLabel("执行段详情").getByText("Fixture Alpha", { exact: true }).waitFor();
      await page.getByTestId("update").click();
      await page.getByLabel("执行段详情").getByText("Fixture Beta", { exact: true }).waitFor();
      const cdp = await context.newCDPSession(page);
      const screenshot = await cdp.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
      });
      await writeFile(fixture.sandbox.logs + "/gantt.png", Buffer.from(screenshot.data, "base64"));
      await page.getByTitle("窗口内全屏", { exact: true }).click();
      assert.equal(await page.evaluate(() => document.body.style.overflow), "hidden");
      await page.keyboard.press("Escape");
      assert.equal(await page.evaluate(() => document.body.style.overflow), "scroll");
      await page.getByTestId("escape-label").click();
      await page.locator(".vis-item-content").filter({ hasText: "<img" }).first().waitFor();
      assert.equal(await page.locator(".gantt-panel img").count(), 0);
      assert.equal(await page.evaluate(() => window.fixtureInjected), undefined);
      await page.getByTitle("窗口内全屏", { exact: true }).click();
      await page.getByTestId("toggle").evaluate((button) => button.click());
      await page.locator(".vis-timeline").waitFor({ state: "detached" });
      assert.equal(await page.evaluate(() => document.body.style.overflow), "scroll");
      assert.deepEqual(await page.evaluate(() => window.fixtureLifecycle), [
        "select:on",
        "select:off",
        "destroy",
      ]);
      await page.getByTestId("toggle").click();
      await page.locator(".vis-timeline").waitFor();
      await page.setViewportSize({ width: 900, height: 700 });
      await page.getByTestId("toggle").click();
      assert.deepEqual(await page.evaluate(() => window.fixtureLifecycle), [
        "select:on",
        "select:off",
        "destroy",
        "select:on",
        "select:off",
        "destroy",
      ]);
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
    } finally {
      await context?.close();
      await fixture.close();
    }
  },
);
