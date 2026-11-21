import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { startProjectBrowserFixture } from "./project-browser-fixture.mjs";
import { assertProjectPath } from "./project-test-sandbox.mjs";

for (const kind of ["agent", "session", "task", "onboarding"])
  test(
    `${kind} Hook keeps scope ownership across one component lifetime`,
    { timeout: 120000 },
    async () => {
      const fixture = await startProjectBrowserFixture({
        label: "service-hook-scope",
        entry: "scripts/ci/fixtures/service-hook-scope-lifecycle.html",
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
        context.setDefaultTimeout(5000);
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
        await page.goto(`${fixture.url}?kind=${kind}`, {
          waitUntil: "domcontentloaded",
          timeout: 45000,
        });
        await page
          .getByRole("button", { name: "Scope context", exact: true })
          .waitFor({ timeout: 45000 });
        if (kind === "onboarding") {
          assert.equal(await page.getByTestId("onboarding-value").innerText(), "B");
          for (const value of ["missing", "throwing", "present"]) {
            await page.getByRole("button", { name: `Onboarding ${value}`, exact: true }).click();
            await page
              .getByTestId("onboarding-value")
              .getByText(value === "present" ? "B" : "null", { exact: true })
              .waitFor();
          }
          assert.equal(await page.evaluate(() => window.serviceFixtureGetterFailures > 0), true);
          scenarios.push({ nullAndGetterFallbackPassed: true });
          await page.goto(`${fixture.url}?kind=onboarding&no-services`, {
            waitUntil: "domcontentloaded",
          });
          await page.getByTestId("onboarding-value").getByText("null", { exact: true }).waitFor();
          scenarios.push({ noServiceProviderPassed: true });
        } else {
          const calls = [];
          async function read(host, rejected = false) {
            await page.getByRole("button", { name: "Read target", exact: true }).click();
            await page
              .getByTestId("request-result")
              .getByText(rejected ? "rejected" : "ok", { exact: true })
              .waitFor();
            if (!rejected) calls.push({ kind, host });
            assert.deepEqual(await page.evaluate(() => window.serviceFixtureCalls), calls);
          }
          await read("B");
          for (const [scope, host] of [
            ["local", "base"],
            ["B", "B"],
            ["C", "C"],
          ]) {
            await page.getByRole("button", { name: `Scope ${scope}`, exact: true }).click();
            assert.equal(await page.getByTestId("fixture-error").count(), 0);
            await read(host);
          }
          await page.getByRole("button", { name: "Disconnect C", exact: true }).click();
          await read(undefined, true);
          await page.getByRole("button", { name: "Reconnect C", exact: true }).click();
          await read("C");
          await page.getByRole("button", { name: "Scope context", exact: true }).click();
          await read("B");
          scenarios.push({
            scopesAndIdentityIsolationPassed: true,
            disconnectedRejectsWithoutBaseCall: true,
          });
          assert.deepEqual(await page.evaluate(() => window.serviceFixtureErrors), []);
          assert.deepEqual(errors, []);
          await page.goto(`${fixture.url}?kind=${kind}&no-tabs`, { waitUntil: "domcontentloaded" });
          calls.splice(0);
          await read("B");
          scenarios.push({ contextWithoutTabProviderPassed: true });
          assert.deepEqual(errors, []);
          await page.getByRole("button", { name: "Scope local", exact: true }).click();
          await page.getByTestId("fixture-error").waitFor();
          assert.deepEqual(await page.evaluate(() => window.serviceFixtureErrors), [
            "useTabStore 必须在 TabStoreProvider 内使用",
          ]);
          assert.equal(
            errors.some((message) => /order of Hooks|Rendered (?:fewer|more) hooks/.test(message)),
            false,
          );
          scenarios.push({ scopedMissingTabProviderRejects: true });
          await page.goto(`${fixture.url}?kind=${kind}`, { waitUntil: "domcontentloaded" });
          errors.splice(0);
        }
        assert.deepEqual(await page.evaluate(() => window.serviceFixtureErrors), []);
        assert.deepEqual(errors, []);
        assert.deepEqual(external, []);
        await writeFile(
          await assertProjectPath(join(fixture.sandbox.root, "scenarios.json")),
          JSON.stringify(
            {
              kind,
              scenarios,
              errors,
              external,
              scope: "real React Hooks/Context/stores, synthetic service ports; no external Host",
            },
            null,
            2,
          ) + "\n",
          { flag: "wx" },
        );
        console.log(`Service Hook evidence: ${fixture.sandbox.root}`);
      } catch (error) {
        console.log(
          JSON.stringify({ kind, errors, external, scenarios, evidence: fixture.sandbox.root }),
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
