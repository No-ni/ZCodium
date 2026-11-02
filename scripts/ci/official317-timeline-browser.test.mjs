import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { startProjectBrowserFixture } from "./project-browser-fixture.mjs";
import { assertProjectPath } from "./project-test-sandbox.mjs";

test(
  "Merged Timeline mounts, grows and changes width with real virtualizer and query navigation",
  { timeout: 120000 },
  async () => {
    const fixture = await startProjectBrowserFixture({
      label: "official317-timeline",
      entry: "scripts/ci/fixtures/official317-timeline.html",
    });
    let context, page;
    const errors = [],
      external = [];
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
      page = await context.newPage();
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      page.on("requestfailed", (request) =>
        errors.push(
          `request failure: ${new URL(request.url()).pathname} ${request.failure()?.errorText}`,
        ),
      );
      page.on("response", (response) => {
        if (response.status() >= 400)
          errors.push(`HTTP ${response.status()}: ${new URL(response.url()).pathname}`);
      });
      page.on("pageerror", (error) => errors.push(error.message));
      for (const theme of ["light", "dark"]) {
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto(`${fixture.url}?theme=${theme}`, {
          waitUntil: "domcontentloaded",
          timeout: 45000,
        });
        const timeline = page.getByTestId("v4-timeline");
        await timeline.waitFor({ timeout: 45000 });
        await page.getByTestId("fixture-composer").waitFor();
        await page.getByRole("button", { name: "Bottom", exact: true }).click();
        await page.getByRole("button", { name: "Grow", exact: true }).click();
        await page.waitForFunction(
          () =>
            document
              .querySelector('[data-testid="v4-timeline"]')
              ?.getAttribute("data-render-unit-count") === "35",
        );
        await page.setViewportSize({ width: 390, height: 900 });
        await page.getByRole("button", { name: "Locate", exact: true }).click();
        await page.waitForFunction(() => document.querySelector('[data-turn-key="turn-1"]'));
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        assert.equal(await page.getByTestId("fixture-composer").isVisible(), true);
        await page.screenshot({
          path: await assertProjectPath(join(fixture.sandbox.root, `timeline-${theme}-390.png`)),
          fullPage: true,
        });
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      console.log(`Timeline component evidence: ${fixture.sandbox.root}`);
    } catch (error) {
      console.log("Timeline fixture errors:", errors);
      console.log("Timeline fixture body:", await page?.locator("body").innerText());
      await page?.screenshot({
        path: await assertProjectPath(join(fixture.sandbox.root, "timeline-failure.png")),
        fullPage: true,
      });
      console.log("Timeline fixture evidence:", fixture.sandbox.root);
      console.log("Timeline external origins:", external);
      throw error;
    } finally {
      await context?.close();
      await fixture.close();
    }
  },
);
