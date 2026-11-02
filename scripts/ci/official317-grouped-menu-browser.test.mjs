import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { startProjectBrowserFixture } from "./project-browser-fixture.mjs";
import { assertProjectPath } from "./project-test-sandbox.mjs";

test(
  "group and task menu events reach the real DOM across display components",
  { timeout: 120000 },
  async () => {
    const fixture = await startProjectBrowserFixture({
      label: "official317-grouped-menu",
      entry: "scripts/ci/fixtures/official317-grouped-menu.html",
    });
    let context;
    const errors = [],
      external = [];
    try {
      const { chromium } = await import("playwright-core");
      const downloads = await assertProjectPath(join(fixture.sandbox.root, "downloads"));
      await mkdir(downloads);
      context = await chromium.launchPersistentContext(
        await assertProjectPath(join(fixture.sandbox.root, "browser-profile")),
        {
          executablePath: await assertProjectPath(process.env.PROJECT_TEST_BROWSER_EXECUTABLE),
          headless: true,
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
      for (const width of [1280, 390])
        for (const noTooltip of [false, true]) {
          await page.setViewportSize({ width, height: 900 });
          await page.goto(fixture.url + (noTooltip ? "?no-tooltip=1" : ""));
          const header = page.getByTestId("task-group-menu");
          await header.click({ button: "right" });
          await page.getByTestId("task-group-rename").click();
          const input = page.getByTestId("task-group-title-input");
          await input.fill("Group B");
          await input.evaluate((el) =>
            el.dispatchEvent(
              new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
            ),
          );
          assert.deepEqual(await page.evaluate(() => window.fixtureCalls), []);
          await input.press("Enter");
          await input.waitFor({ state: "hidden" });
          assert.deepEqual(await page.evaluate(() => window.fixtureCalls), [{ title: "Group B" }]);
          await header.click({ button: "right" });
          await page.getByTestId("task-group-rename").click();
          await input.fill("Cancelled name");
          await input.press("Escape");
          await input.waitFor({ state: "hidden" });
          assert.deepEqual(await page.evaluate(() => window.fixtureCalls), [{ title: "Group B" }]);
          await page.locator('[data-task-item-key="fixture-row"]').click({ button: "right" });
          await page.getByTestId("fixture-task-menu-action").click();
          assert.deepEqual(await page.evaluate(() => window.fixtureCalls), [
            { title: "Group B" },
            { taskMenu: true },
          ]);
          assert.equal(await header.getAttribute("aria-roledescription"), "draggable");
          await page.screenshot({
            path: await assertProjectPath(
              join(fixture.sandbox.root, `menus-${width}-${noTooltip}.png`),
            ),
            fullPage: true,
          });
        }
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      console.log(`Grouped menu browser evidence: ${fixture.sandbox.root}`);
    } finally {
      await context?.close();
      await fixture.close();
    }
  },
);
