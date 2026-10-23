import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright-core";

const titles = {
  settled: "settled A is replaced by B in the same scope",
  pending: "pending A cannot overwrite B in the same scope",
  pane: "closing the pane preserves its in-flight extended request",
  strict: "StrictMode replays startup without keeping an obsolete request",
};
for (const scenario of Object.keys(titles)) {
  test(`Git service generation: ${titles[scenario]}`, { timeout: 60_000 }, async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const temporaryRoot = await mkdtemp(join(tmpdir(), "zcodium-git-service-browser-"));
    let server;
    let browser;
    try {
      server = await createServer({
        configFile: false,
        root,
        cacheDir: join(temporaryRoot, "vite-cache"),
        optimizeDeps: {
          noDiscovery: true,
          include: ["react", "react-dom/client"],
        },
        plugins: [react()],
        resolve: {
          alias: [
            {
              find: "@/hooks/useResolvedRemoteWorkspaceSessionId.js",
              replacement: resolve(root, "packages/ui/test/performance-git-service-scope.ts"),
            },
            { find: "@", replacement: resolve(root, "packages/ui/src") },
          ],
          dedupe: ["react", "react-dom"],
        },
        server: { host: "127.0.0.1", port: 0 },
        logLevel: "error",
      });
      await server.listen();
      browser = await chromium.launch({
        channel: process.platform === "win32" ? "msedge" : "chrome",
        headless: true,
      });
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(
        `${server.resolvedUrls.local[0]}packages/ui/test/performance-git-service.html?scenario=${scenario}`,
      );
      await page.waitForFunction(
        (count) => window.gitServiceFixture?.requests().length === count,
        scenario === "strict" ? 2 : 1,
      );
      if (scenario === "pane" || scenario === "strict") {
        if (scenario === "pane") {
          await page.getByRole("button", { name: "Close pane" }).click();
          assert.deepEqual(await page.evaluate(() => window.gitServiceFixture.requests()), ["A"]);
        } else {
          await page.evaluate(() => window.gitServiceFixture.complete("A", "obsolete"));
          assert.equal(await page.locator("#branch").textContent(), "");
        }
        await page.evaluate(() => window.gitServiceFixture.complete("A", "current"));
        await page.waitForFunction(
          () => document.querySelector("#branch").textContent === "current",
        );
        assert.equal(await page.locator("#loading").textContent(), "false");
        assert.equal(await page.locator("#error").textContent(), "");
        assert.equal(
          (await page.evaluate(() => window.gitServiceFixture.requests())).length,
          scenario === "strict" ? 2 : 1,
        );
        assert.deepEqual(errors, []);
        return;
      }
      if (scenario === "settled") {
        await page.evaluate(() => window.gitServiceFixture.complete("A"));
        await page.waitForFunction(() => document.querySelector("#branch").textContent === "A");
      }
      await page.getByRole("button", { name: "Replace service" }).click();
      await page.waitForFunction(() => window.gitServiceFixture.requests().length === 2);
      assert.deepEqual(await page.evaluate(() => window.gitServiceFixture.requests()), ["A", "B"]);
      assert.equal(await page.locator("#branch").textContent(), "");
      assert.equal(await page.locator("#watch-paths").textContent(), "");
      assert.equal(await page.locator("#loading").textContent(), "true");
      await page.evaluate(() => window.gitServiceFixture.complete("B"));
      await page.waitForFunction(() => document.querySelector("#branch").textContent === "B");
      if (scenario === "pending") {
        await page.evaluate(async () => {
          window.gitServiceFixture.complete("A", "late-A");
          await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        });
      }
      assert.equal(await page.locator("#branch").textContent(), "B");
      assert.equal(await page.locator("#watch-paths").textContent(), "/synthetic/B/.git");
      assert.equal(await page.locator("#loading").textContent(), "false");
      assert.equal(await page.locator("#error").textContent(), "");
      assert.deepEqual(errors, []);
    } finally {
      try {
        await browser?.close();
      } finally {
        try {
          await server?.close();
        } finally {
          await rm(temporaryRoot, { recursive: true, force: true });
        }
      }
    }
  });
}
