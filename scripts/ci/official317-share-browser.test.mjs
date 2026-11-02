import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { startProjectBrowserFixture } from "./project-browser-fixture.mjs";
import { assertProjectPath } from "./project-test-sandbox.mjs";

test(
  "Local archive popover keeps its range transaction and Composer at both widths",
  { timeout: 120000 },
  async () => {
    const fixture = await startProjectBrowserFixture({
      label: "official317-share-ui",
      entry: "scripts/ci/fixtures/official317-share.html",
    });
    let context;
    const errors = [],
      external = [];
    try {
      const { chromium } = await import("playwright-core");
      const profile = await assertProjectPath(join(fixture.sandbox.root, "profile"));
      const downloadsPath = await assertProjectPath(join(fixture.sandbox.root, "downloads"));
      await mkdir(downloadsPath);
      context = await chromium.launchPersistentContext(profile, {
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
      });
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
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(fixture.url);
        await page.getByTestId("conversation-share-trigger").click();
        const popover = page.getByTestId("conversation-share-popover");
        await popover.waitFor();
        await page.getByTestId("conversation-share-adjust").click();
        const panel = page.getByTestId("conversation-share-selection-panel");
        await panel.waitFor();
        const checks = panel.getByRole("checkbox");
        await checks.nth(1).uncheck();
        assert.equal(await page.getByTestId("confirmed-count").innerText(), "3");
        await page.keyboard.press("Escape");
        await panel.waitFor({ state: "hidden" });
        assert.equal(await popover.isVisible(), true);
        assert.equal(await page.getByTestId("confirmed-count").innerText(), "3");
        await page.getByTestId("conversation-share-adjust").click();
        await panel.waitFor();
        await checks.nth(1).uncheck();
        await panel.getByTestId("conversation-share-selection-apply").click();
        await panel.waitFor({ state: "hidden" });
        assert.equal(await page.getByTestId("confirmed-count").innerText(), "2");
        assert.equal(await page.getByRole("textbox", { name: "Composer" }).isVisible(), true);
        await page.getByTestId("conversation-share-disclosure-checkbox").check();
        await page.getByTestId("conversation-share-confirm").click();
        assert.equal(await page.getByTestId("publish-count").innerText(), "1");
        assert.equal(await page.getByTestId("conversation-share-trigger").isDisabled(), true);
        await page.keyboard.press("Escape");
        assert.equal(await popover.isVisible(), true);
        await page.getByTestId("complete-export").click();
        await page.getByTestId("conversation-share-success-dock").waitFor();
        await page.getByTestId("conversation-share-success-dismiss").click();
        await popover.waitFor({ state: "hidden" });
        await page.getByTestId("conversation-share-trigger").click();
        await popover.waitFor();
        assert.equal(await page.getByTestId("conversation-share-success-dock").count(), 0);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await page.screenshot({
          path: await assertProjectPath(join(fixture.sandbox.root, `share-${width}.png`)),
          fullPage: true,
        });
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      console.log(`Local share UI evidence: ${fixture.sandbox.root}`);
    } finally {
      await context?.close();
      await fixture.close();
    }
  },
);
