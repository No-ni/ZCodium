import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { startProjectBrowserFixture } from "./project-browser-fixture.mjs";
import { assertProjectPath } from "./project-test-sandbox.mjs";

test(
  "WINUI17/19 real recording, steal, blocked restore and retry in StrictMode on desktop and narrow Web",
  { timeout: 240000 },
  async () => {
    const fixture = await startProjectBrowserFixture({
      label: "winui-shortcut-restore",
      entry: "scripts/ci/fixtures/windows-ui-regressions.html",
      optimizeDepsInclude: [
        "qrcode",
        "border-beam",
        "ansi-to-react",
        "react-jsx-parser",
        "react-pdf",
      ],
    });
    let context;
    const errors = [],
      external = [];
    try {
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
      for (const [platform, locale, width] of [
        ["windows", "en-US", 1280],
        ["windows", "zh-CN", 1280],
        ["mac", "en-US", 1280],
        ["web", "zh-CN", 390],
      ]) {
        const page = await context.newPage();
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text());
        });
        await page.addInitScript((apple) => {
          Object.defineProperty(navigator, "platform", {
            get: () => (apple ? "MacIntel" : "Win32"),
          });
          Object.defineProperty(navigator, "userAgent", {
            get: () => (apple ? "Fixture Mac" : "Fixture Windows"),
          });
        }, platform === "mac");
        await page.setViewportSize({ width, height: 900 });
        await page.goto(
          `${fixture.url}?view=settings&strict=1&platform=${platform}&locale=${locale}`,
        );
        await page.getByTestId("settings-section-nav-shortcuts").click();
        await page.getByTestId("settings-shortcut-edit-toggleSidebar-0").click();
        await page.keyboard.press(platform === "mac" ? "Meta+Shift+P" : "Control+Shift+P");
        await page.getByTestId("settings-shortcut-steal-toggleSidebar").click();
        await page.waitForFunction(() => window.fixtureCalls.localSettingsWrites.length === 1);
        await page.getByTestId("settings-shortcut-bind-openCommandCenter-0").waitFor();
        assert.deepEqual(
          await page.evaluate(() => window.fixtureCalls.localSettingsWrites.at(-1)),
          {
            shortcutBindings: {
              toggleSidebar: ["CmdOrCtrl+Shift+p"],
              openCommandCenter: ["CmdOrCtrl+k"],
            },
          },
        );
        await page.getByTestId("settings-shortcut-edit-openCommandCenter-0").click();
        await page.keyboard.press("Backspace");
        await page.getByTestId("settings-shortcut-bind-openCommandCenter-0").waitFor();
        await page.screenshot({
          path: await assertProjectPath(
            join(fixture.sandbox.root, `${platform}-${locale}-restore.png`),
          ),
          fullPage: true,
        });
        assert.equal(
          await page.evaluate(() => window.fixtureCalls.localSettingsWrites.length),
          1,
          "occupied second default must block the entire restore without writing settings",
        );
        const conflict =
          locale === "zh-CN"
            ? "默认键已被「切换左侧栏」占用，恢复默认会造成同键冲突，请先调整该命令"
            : 'The default key is already used by "Toggle Sidebar"; restoring it would create a conflict. Adjust that command first';
        await page.getByText(conflict, { exact: true }).waitFor();
        assert.equal(
          await page.getByTestId("settings-shortcut-bind-openCommandCenter-1").count(),
          0,
        );
        await page.evaluate(() => window.fixture.setView("shortcut-probe"));
        await page.getByTestId("shortcut-probe-label").waitFor();
        await page.keyboard.press(platform === "mac" ? "Meta+Shift+P" : "Control+Shift+P");
        await page.waitForFunction(() => window.fixtureCalls.keyboard === 1);
        await page.evaluate(() => window.fixture.setView("settings"));
        await page.getByTestId("settings-section-nav-shortcuts").click();
        await page.getByTestId("settings-shortcut-clear-toggleSidebar").click();
        await page.waitForFunction(() => window.fixtureCalls.localSettingsWrites.length === 2);
        await page.getByTestId("settings-shortcut-bind-toggleSidebar-unassigned").waitFor();
        await page.getByTestId("settings-shortcut-edit-openCommandCenter-0").click();
        await page.keyboard.press("Backspace");
        await page.getByTestId("settings-shortcut-bind-openCommandCenter-1").waitFor();
        assert.deepEqual(
          await page.evaluate(() => window.fixtureCalls.localSettingsWrites.at(-1)),
          {
            shortcutBindings: { toggleSidebar: [] },
          },
        );
        assert.equal(await page.evaluate(() => window.fixtureCalls.localSettingsWrites.length), 3);
        assert.deepEqual(
          await page.evaluate(() => [
            window.fixtureCalls.foreignSettingsReads,
            window.fixtureCalls.foreignSettingsWrites.length,
          ]),
          [0, 0],
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        await page.screenshot({
          path: await assertProjectPath(
            join(fixture.sandbox.root, `${platform}-${locale}-restored.png`),
          ),
          fullPage: true,
        });
        await page.close();
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      console.log(`WINUI17 evidence: ${fixture.sandbox.root}`);
    } finally {
      await context?.close();
      await fixture.close();
    }
  },
);
