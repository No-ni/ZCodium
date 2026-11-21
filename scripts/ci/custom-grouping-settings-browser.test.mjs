import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import test from "node:test";
import { startProjectBrowserFixture } from "./project-browser-fixture.mjs";
import { assertProjectPath, projectRoot } from "./project-test-sandbox.mjs";
import { loadComponentCallback } from "./fixtures/component-callback.mjs";
import { groupingProductionModule } from "./fixtures/custom-grouping-production.mjs";

const fields = [
  "toolGroupingExploreEnabled",
  "toolGroupingTerminalEnabled",
  "toolGroupingChangesEnabled",
];
const names = [
  "handleToolGroupingExploreEnabledChange",
  "handleToolGroupingTerminalEnabledChange",
  "handleToolGroupingChangesEnabledChange",
];
const labels = {
  "en-US": ["Group exploration tools", "Group terminal commands", "Group file changes"],
  "zh-CN": ["探索工具分组", "终端命令分组", "文件变更分组"],
};

test(
  "real grouping controls invoke production callbacks, persist and reload at desktop/mobile widths",
  { timeout: 120000 },
  async () => {
    const fixture = await startProjectBrowserFixture({
      label: "custom-grouping-ui",
      entry: "scripts/ci/fixtures/custom-grouping-settings.html",
    });
    let context;
    const errors = [],
      external = [];
    try {
      const { createSettingService } =
        await import("../../packages/services/src/setting/settingService.ts");
      const file = await assertProjectPath(join(fixture.sandbox.root, "settings.json"));
      const service = createSettingService({ settingsFilePath: file });
      const projectionFile = await assertProjectPath(
        join(fixture.sandbox.root, "grouping-projection.mjs"),
      );
      await writeFile(projectionFile, await groupingProductionModule());
      const projectionUrl = "/" + relative(projectRoot, projectionFile).split("\\").join("/");
      const callbacks = new Map();
      for (const name of names)
        callbacks.set(
          name,
          await loadComponentCallback("packages/ui/src/SettingsPage.tsx", name, {
            updateSharedSettings: (patch) => service.update(patch),
          }),
        );
      const { chromium } = await import("playwright-core");
      const downloads = await assertProjectPath(join(fixture.sandbox.root, "downloads"));
      await mkdir(downloads);
      context = await chromium.launchPersistentContext(
        await assertProjectPath(join(fixture.sandbox.root, "profile")),
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
      await context.route("**/fixture/settings", async (route) => {
        if (route.request().method() === "POST") {
          const { handler, value } = route.request().postDataJSON();
          assert.equal(typeof value, "boolean");
          assert.ok(callbacks.has(handler));
          await callbacks.get(handler)(value);
        }
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(await service.get()),
        });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.on("pageerror", (error) => errors.push(error.message));
      for (const [locale, width] of [
        ["en-US", 1280],
        ["zh-CN", 390],
      ]) {
        await service.update({
          locale,
          ...Object.fromEntries(fields.map((field) => [field, true])),
          webRemoteControlEndpointMode: "custom",
          webRemoteControlCustomEndpointUrl: "wss://relay.example.invalid/ws",
        });
        await page.setViewportSize({ width, height: 900 });
        await page.goto(
          `${fixture.url}?locale=${locale}&projection=${encodeURIComponent(projectionUrl)}`,
        );
        await page.getByTestId("grouping-projection").waitFor();
        const projection = async () =>
          JSON.parse(await page.getByTestId("grouping-projection").textContent());
        assert.deepEqual((await projection()).flags, [true, true, true]);
        assert.deepEqual((await projection()).kinds, [
          "exploreGroup",
          "executeGroup",
          "changesGroup",
        ]);
        for (const label of labels[locale]) {
          const toggle = page.getByRole("switch", { name: label, exact: true });
          await toggle.waitFor();
          assert.equal(await toggle.getAttribute("aria-checked"), "true");
          await toggle.click();
          await page.waitForFunction(
            (name) =>
              document.querySelector(`[aria-label="${name}"]`)?.getAttribute("aria-checked") ===
              "false",
            label,
          );
        }
        assert.deepEqual((await projection()).flags, [false, false, false]);
        assert.deepEqual((await projection()).kinds, Array(6).fill("row"));
        await service.update({ terminalFontFamily: "monospace" });
        await page.reload();
        for (const label of labels[locale]) {
          const toggle = page.getByRole("switch", { name: label, exact: true });
          await toggle.waitFor();
          assert.equal(await toggle.getAttribute("aria-checked"), "false");
        }
        assert.deepEqual((await projection()).kinds, Array(6).fill("row"));
        const saved = await createSettingService({ settingsFilePath: file }).get();
        for (const field of fields) assert.equal(saved[field], false);
        assert.equal(saved.webRemoteControlEndpointMode, "custom");
        assert.equal(saved.webRemoteControlCustomEndpointUrl, "wss://relay.example.invalid/ws");
        assert.equal(await page.getByRole("alert").count(), 0);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await page.screenshot({
          path: await assertProjectPath(
            join(fixture.sandbox.root, `grouping-${locale}-${width}.png`),
          ),
          fullPage: true,
        });
        assert.equal(JSON.parse(await readFile(file, "utf8")).toolGroupingExploreEnabled, false);
        for (const label of labels[locale]) {
          await page.getByRole("switch", { name: label, exact: true }).click();
          await page.waitForFunction(
            (name) =>
              document.querySelector(`[aria-label="${name}"]`)?.getAttribute("aria-checked") ===
              "true",
            label,
          );
        }
        assert.deepEqual((await projection()).kinds, [
          "exploreGroup",
          "executeGroup",
          "changesGroup",
        ]);
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      console.log(`Grouping settings browser evidence: ${fixture.sandbox.root}`);
    } finally {
      await context?.close();
      await fixture.close();
    }
  },
);
