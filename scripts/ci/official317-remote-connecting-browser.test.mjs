import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { startProjectBrowserFixture } from "./project-browser-fixture.mjs";
import { assertProjectPath } from "./project-test-sandbox.mjs";

test(
  "predeployed connection UI exposes cancellation, credential admission and directory continuation",
  { timeout: 120000 },
  async () => {
    const fixture = await startProjectBrowserFixture({
      label: "official317-connecting-ui",
      entry: "scripts/ci/fixtures/official317-remote-connecting.html",
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
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(fixture.url);
        await page.getByTestId("remote-connection-cancel").click();
        await page.getByRole("button", { name: "Continue in background" }).click();
        await page.getByTestId("fixture-credential").click();
        const submit = page.getByRole("button", { name: "Retry connection" });
        assert.equal(await submit.isDisabled(), true);
        await page.getByTestId("remote-connection-credential").fill("fixture-only");
        await submit.click();
        await page.getByTestId("fixture-ready").click();
        await page.getByTestId("remote-connection-continue").click();
        await page.getByTestId("fixture-manual").click();
        assert.equal(
          await page.getByRole("button", { name: /update|install|download|reinstall/i }).count(),
          0,
        );
        assert.equal(await page.getByRole("button", { name: "Retry connection" }).count(), 0);
        assert.equal(await page.locator("[data-phase=deploy]").count(), 0);
        assert.deepEqual(await page.evaluate(() => window.fixtureCalls), [
          "cancel",
          "minimize",
          "credential-submit",
          "directory",
        ]);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await page.screenshot({
          path: await assertProjectPath(join(fixture.sandbox.root, `connecting-${width}.png`)),
          fullPage: true,
        });
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      console.log(`Connection UI acceptance evidence: ${fixture.sandbox.root}`);
    } finally {
      await context?.close();
      await fixture.close();
    }
  },
);
