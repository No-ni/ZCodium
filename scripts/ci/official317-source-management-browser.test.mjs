import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { startProjectBrowserFixture } from "./project-browser-fixture.mjs";
import { assertProjectPath } from "./project-test-sandbox.mjs";

test(
  "canonical Source settings confirms lifecycle actions at desktop and mobile widths",
  { timeout: 120000 },
  async () => {
    const fixture = await startProjectBrowserFixture({
      label: "official317-source-ui",
      entry: "scripts/ci/fixtures/official317-source-management.html",
    });
    console.log("Source UI fixture ready");
    let context;
    const errors = [],
      external = [];
    try {
      const { chromium } = await import("playwright-core");
      const profile = await assertProjectPath(join(fixture.sandbox.root, "browser-profile"));
      const downloads = await assertProjectPath(join(fixture.sandbox.root, "downloads"));
      await mkdir(downloads);
      context = await chromium.launchPersistentContext(profile, {
        executablePath: await assertProjectPath(process.env.PROJECT_TEST_BROWSER_EXECUTABLE),
        headless: true,
        timeout: 30000,
        env: fixture.sandbox.env,
        downloadsPath: downloads,
        args: [
          "--disable-background-networking",
          "--disable-component-update",
          "--disable-sync",
          "--disable-breakpad",
          "--no-first-run",
          "--no-default-browser-check",
        ],
      });
      console.log("Source UI browser launched");
      context.setDefaultTimeout(15000);
      context.setDefaultNavigationTimeout(30000);
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
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(fixture.url);
        console.log(`Source UI loaded at ${width}`);
        await page.getByTestId("source-server-stop").click();
        const dialog = page.getByRole("alertdialog");
        await dialog.waitFor();
        assert.match(await dialog.innerText(), /did(?: not|n't) provide|unavailable/i);
        assert.deepEqual(await page.evaluate(() => window.fixtureCalls), ["running-tasks"]);
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        assert.deepEqual(await page.evaluate(() => window.fixtureCalls), ["running-tasks"]);
        await page.getByTestId("source-server-stop").click();
        await dialog.getByTestId("source-server-lifecycle-confirm").click();
        await page.waitForFunction(() => window.fixtureCalls.includes("stop"));
        await page.getByTestId("source-server-restart").click();
        await dialog.waitFor();
        await dialog.getByTestId("source-server-lifecycle-confirm").click();
        await page.waitForFunction(() => window.fixtureCalls.includes("restart"));
        await dialog.waitFor({ state: "hidden" });
        assert.deepEqual(await page.evaluate(() => window.fixtureCalls), [
          "running-tasks",
          "running-tasks",
          "stop",
          "running-tasks",
          "restart",
        ]);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await page.screenshot({
          path: await assertProjectPath(join(fixture.sandbox.root, `source-settings-${width}.png`)),
          fullPage: true,
        });
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      console.log(`Source UI acceptance evidence: ${fixture.sandbox.root}`);
    } finally {
      console.log("Source UI closing browser");
      await context?.close();
      console.log("Source UI closing fixture");
      await fixture.close();
    }
  },
);
