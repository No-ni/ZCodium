import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { startProjectBrowserFixture } from "./project-browser-fixture.mjs";
import { assertProjectPath } from "./project-test-sandbox.mjs";

test(
  "admission reminder read/dismiss state follows workspace, kind and digest at both widths",
  { timeout: 120000 },
  async () => {
    const fixture = await startProjectBrowserFixture({
      label: "official317-indicators",
      entry: "scripts/ci/fixtures/official317-admission-indicators.html",
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
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      for (const [theme, width] of [
        ["light", 1280],
        ["dark", 390],
      ]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${fixture.url}?theme=${theme}`);
        const a = page.getByTestId("pane-a"),
          copy = page.getByTestId("pane-a-copy"),
          b = page.getByTestId("pane-b");
        await a.getByTestId("v4-workspace-hook-pending-trigger").waitFor();
        assert.equal(await page.getByTestId("pane-stale").getByRole("button").count(), 0);
        await a.getByTestId("v4-workspace-hook-pending-trigger").click();
        assert.equal(await a.getByTestId("v4-workspace-hook-pending-unread").count(), 0);
        assert.equal(await copy.getByTestId("v4-workspace-hook-pending-unread").count(), 0);
        assert.equal(await b.getByTestId("v4-workspace-hook-pending-unread").count(), 1);
        assert.equal(
          await page.getByTestId("mcp").getByTestId("v4-workspace-mcp-pending-unread").count(),
          1,
        );
        await page.getByTestId("v4-workspace-hook-pending-dismiss").click();
        await a.getByTestId("v4-workspace-hook-pending-trigger").waitFor({ state: "hidden" });
        assert.equal(await copy.getByRole("button").count(), 0);
        assert.equal(await b.getByRole("button").count(), 1);
        await page.getByRole("button", { name: "Change digest" }).click();
        await a.getByTestId("v4-workspace-hook-pending-unread").waitFor();
        await page.getByTestId("mcp").getByTestId("v4-workspace-mcp-pending-trigger").click();
        await page.getByTestId("v4-workspace-mcp-pending-popover").waitFor();
        await page.waitForFunction(
          () =>
            Number(
              getComputedStyle(
                document.querySelector('[data-testid="v4-workspace-mcp-pending-popover"]'),
              ).opacity,
            ) >= 0.99,
        );
        assert.equal(await page.getByRole("textbox", { name: "Composer" }).isVisible(), true);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await page.screenshot({
          path: await assertProjectPath(
            join(fixture.sandbox.root, `indicators-${theme}-${width}.png`),
          ),
          fullPage: true,
        });
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      console.log(`Admission indicator evidence: ${fixture.sandbox.root}`);
    } catch (error) {
      console.log("Admission fixture errors:", errors);
      await page?.screenshot({
        path: await assertProjectPath(join(fixture.sandbox.root, "indicators-failure.png")),
        fullPage: true,
      });
      throw error;
    } finally {
      await context?.close();
      await fixture.close();
    }
  },
);
