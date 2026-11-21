import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { startProjectBrowserFixture } from "./project-browser-fixture.mjs";
import { assertProjectPath } from "./project-test-sandbox.mjs";

for (const initial of ["unjoined", "joined"]) {
  test(
    `ResumeWorkflowRun keeps one mounted tool across ${initial} join transitions`,
    { timeout: 120000 },
    async () => {
      const fixture = await startProjectBrowserFixture({
        label: "workflow-resume-card",
        entry: "scripts/ci/fixtures/workflow-resume-card-lifecycle.html",
        productFlavor: "zcodium",
        updateOrigin: "",
      });
      let context, page;
      const errors = [],
        external = [],
        scenarios = [];
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
            timeout: 30000,
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
        context.setDefaultTimeout(7000);
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
        for (const theme of ["light", "dark"])
          for (const width of [1280, 390]) {
            await page.setViewportSize({ width, height: 800 });
            await page.goto(`${fixture.url}?initial=${initial}&theme=${theme}`, {
              waitUntil: "domcontentloaded",
              timeout: 45000,
            });
            const tool = page.getByTestId("fixture-tool"),
              card = page.getByTestId("workflow-run-card");
            await tool.waitFor({ timeout: 45000 });
            if (initial === "joined") {
              await card.waitFor();
              await page.getByRole("button", { name: "Detach run", exact: true }).click();
              await card.waitFor({ state: "hidden" });
              assert.equal(await tool.getByTestId("fixture-render-error").count(), 0);
            }
            assert.match(await tool.innerText(), /E2E_WRC_RUN/);
            await page.getByRole("button", { name: "Join run", exact: true }).click();
            await card.waitFor();
            assert.equal(await card.getAttribute("data-workflow-run-status"), "running");
            assert.match(await card.innerText(), /1.*3/);
            await card.click();
            await card.press("Enter");
            await card.press("Space");
            assert.deepEqual(await page.evaluate(() => window.workflowFixtureOpens), [{}, {}, {}]);
            await page.getByRole("button", { name: "Finish run", exact: true }).click();
            await page.waitForFunction(
              () =>
                document
                  .querySelector('[data-testid="workflow-run-card"]')
                  ?.getAttribute("data-workflow-run-status") === "completed",
            );
            assert.match(await card.innerText(), /3.*3/);
            await page.getByRole("button", { name: "Detach run", exact: true }).click();
            await card.waitFor({ state: "hidden" });
            assert.equal(await tool.getByTestId("fixture-render-error").count(), 0);
            await page.getByRole("button", { name: "Legacy output", exact: true }).click();
            await tool.getByText("E2E_WRC_LEGACY_OUTPUT", { exact: true }).waitFor();
            await page.getByRole("button", { name: "Join run", exact: true }).click();
            await card.waitFor();
            assert.equal(await card.getAttribute("data-workflow-run-id"), "E2E_WRC_RUN");
            assert.equal(
              await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
              true,
            );
            assert.deepEqual(await page.evaluate(() => window.workflowFixtureErrors), []);
            scenarios.push({
              initial,
              theme,
              width,
              stateTransitionsPassed: true,
              keyboardAndMousePassed: true,
            });
            await page.screenshot({
              path: await assertProjectPath(
                join(fixture.sandbox.root, `${initial}-${theme}-${width}.png`),
              ),
              fullPage: true,
            });
          }
        assert.deepEqual(errors, []);
        assert.deepEqual(external, []);
        await writeFile(
          await assertProjectPath(join(fixture.sandbox.root, "scenarios.json")),
          JSON.stringify(
            {
              scenarios,
              errors,
              external,
              scope:
                "real component browser fixture; synthetic render context; no Electron/Host/Provider",
            },
            null,
            2,
          ) + "\n",
          { flag: "wx" },
        );
        console.log(`Workflow resume card evidence: ${fixture.sandbox.root}`);
      } catch (error) {
        console.log(
          JSON.stringify({ errors, external, scenarios, evidence: fixture.sandbox.root }),
        );
        if (page) {
          console.log(await page.locator("body").innerText());
          await page.screenshot({
            path: await assertProjectPath(join(fixture.sandbox.root, "failure.png")),
            fullPage: true,
          });
        }
        throw error;
      } finally {
        await context?.close();
        await fixture.close();
      }
    },
  );
}
