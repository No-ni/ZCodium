import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { startProjectBrowserFixture } from "./project-browser-fixture.mjs";
import { assertProjectPath } from "./project-test-sandbox.mjs";

test("General forwards auto archive values and commands to the existing control", async () => {
  const source = await readFile("packages/ui/src/settingsPageHelpers.tsx", "utf8");
  const file = ts.createSourceFile(
    "settings.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const general = file.statements.find(
    (n) => ts.isFunctionDeclaration(n) && n.name?.text === "GeneralSectionContent",
  );
  const controls = [];
  function visit(n) {
    if (ts.isJsxSelfClosingElement(n) && n.tagName.getText(file) === "TaskAutoArchiveSettings")
      controls.push(n);
    ts.forEachChild(n, visit);
  }
  visit(general);
  assert.equal(controls.length, 1);
  for (const name of [
    "taskAutoArchiveEnabled",
    "taskAutoArchiveOlderThanDays",
    "onTaskAutoArchiveEnabledChange",
    "onTaskAutoArchiveOlderThanDaysChange",
  ]) {
    const p = controls[0].attributes.properties.find((p) => p.name?.getText(file) === name);
    assert.equal(p?.initializer?.expression?.getText(file), name);
  }
});

test(
  "archive controls save the threshold before enabling at desktop and mobile widths",
  { timeout: 120000 },
  async () => {
    const fixture = await startProjectBrowserFixture({
      label: "official317-archive-ui",
      entry: "scripts/ci/fixtures/official317-auto-archive.html",
    });
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
        const toggle = page.getByTestId("archive-auto-archive-switch");
        assert.equal(await toggle.getAttribute("aria-checked"), "false");
        await page.getByTestId("archive-auto-archive-days").click();
        await page.getByRole("option", { name: /30/ }).click();
        assert.deepEqual(await page.evaluate(() => window.fixtureCalls), [
          { taskAutoArchiveOlderThanDays: 30 },
        ]);
        await toggle.click();
        assert.equal(await toggle.getAttribute("aria-checked"), "true");
        assert.deepEqual(await page.evaluate(() => window.fixtureCalls), [
          { taskAutoArchiveOlderThanDays: 30 },
          { taskAutoArchiveEnabled: true },
        ]);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await page.screenshot({
          path: await assertProjectPath(
            join(fixture.sandbox.root, `archive-settings-${width}.png`),
          ),
          fullPage: true,
        });
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      console.log(`Archive component browser evidence: ${fixture.sandbox.root}`);
    } finally {
      await context?.close();
      await fixture.close();
    }
  },
);
