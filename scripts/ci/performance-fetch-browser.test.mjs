import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import test from "node:test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright-core";

test(
  "file index stops cancelled chunks and restarts same-service identity scopes",
  { timeout: 60_000 },
  async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const temporaryRoot = await mkdtemp(join(tmpdir(), "zcodium-performance-fetch-"));
    let server;
    let browser;
    try {
      server = await createServer({
        configFile: false,
        root,
        // useWorkspaceServices 的夹具 alias 不能污染其他 server 的依赖缓存。
        cacheDir: join(temporaryRoot, "vite-cache"),
        optimizeDeps: { entries: [resolve(root, "packages/ui/test/performance-fetch.html")] },
        plugins: [react()],
        resolve: {
          alias: [
            {
              find: "@/hooks/useWorkspaceServices.js",
              replacement: resolve(root, "packages/ui/test/performance-fetch-services.ts"),
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
      await page.goto(`${server.resolvedUrls.local[0]}packages/ui/test/performance-fetch.html`);
      const pendingCount = async (count) =>
        page.waitForFunction((value) => window.fileFetchFixture.pending().length === value, count);
      await pendingCount(1);
      await page.getByRole("button", { name: "Close search" }).click();
      await page.evaluate(() => window.fileFetchFixture.complete(0, "old"));
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => window.fileFetchFixture.pending().length), 1);
      assert.equal(await page.locator("#loading").textContent(), "false");
      assert.equal(await page.locator("#packed").textContent(), "");
      assert.equal(await page.locator("#error").textContent(), "");
      await page.getByRole("button", { name: "Open search" }).click();
      await pendingCount(2);
      await page.getByRole("button", { name: "Switch identity" }).click();
      await pendingCount(3);
      assert.equal(await page.evaluate(() => window.fileFetchFixture.lengths().length), 3);
      await page.evaluate(() => window.fileFetchFixture.complete(1, "stale"));
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => window.fileFetchFixture.pending().length), 3);
      await page.evaluate(() => window.fileFetchFixture.complete(2, "current-a"));
      await pendingCount(4);
      await page.evaluate(() => window.fileFetchFixture.complete(3, "current-b"));
      await pendingCount(5);
      await page.evaluate(() => window.fileFetchFixture.complete(4, "current-c"));
      await page.waitForFunction(
        () => document.querySelector("#packed").textContent === "current-acurrent-bcurrent-c",
      );
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await pendingCount(6);
      await page.getByRole("button", { name: "Switch remote session" }).click();
      await pendingCount(7);
      await page.evaluate(() => window.fileFetchFixture.complete(5, "old-session"));
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => window.fileFetchFixture.pending().length), 7);
      await page.getByRole("button", { name: "Unmount" }).click();
      await page.evaluate(() => window.fileFetchFixture.complete(6, "unmounted"));
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => window.fileFetchFixture.pending().length), 7);
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
  },
);
