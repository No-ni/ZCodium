import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright-core";

test(
  "find DOM and snippet work stays bounded with repeated hits",
  { timeout: 60_000 },
  async (t) => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const temporaryRoot = await mkdtemp(join(tmpdir(), "zcodium-performance-round11-find-"));
    let server;
    let browser;
    try {
      server = await createServer({
        configFile: false,
        root,
        cacheDir: join(temporaryRoot, "vite-cache"),
        plugins: [react()],
        resolve: {
          alias: { "@": resolve(root, "packages/ui/src") },
          dedupe: ["react", "react-dom"],
        },
        optimizeDeps: {
          noDiscovery: true,
          include: [
            "react",
            "react-dom",
            "react-dom/client",
            "react/jsx-runtime",
            "react/jsx-dev-runtime",
          ],
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
      await page.addInitScript(() => {
        const original = String.prototype.toLocaleLowerCase;
        window.round11BodyNormalizations = 0;
        String.prototype.toLocaleLowerCase = function (...args) {
          if (String(this).startsWith("needle needle needle")) window.round11BodyNormalizations++;
          return original.apply(this, args);
        };
      });
      await page.goto(
        `${server.resolvedUrls.local[0]}packages/ui/test/performance-round11-find.html`,
      );
      await page.getByRole("button", { name: "Locate snippet" }).waitFor();
      await t.test("DOM ranges are shared per mounted row and refreshed next apply", async () => {
        const result = await page.evaluate(() => window.round11Find.domBudget());
        t.diagnostic(
          `DOM Range creations: ${result.createdRanges} for ${result.highlights} highlights`,
        );
        assert.equal(result.highlights, 500);
        assert.equal(result.activeText, "needle");
        assert.ok(result.createdRanges <= 500, JSON.stringify(result));
        assert.equal(result.sharedActive, true);
        assert.equal(result.changed, true);
        assert.equal(result.missing, 0);
        assert.equal(result.remounted, 1);
        assert.equal(result.firstDomRow, true);
        assert.equal(result.activeOutsideMatches, true);
        assert.deepEqual(result.priorities, [0, 1]);
        assert.equal(result.textNodeBoundaries, true);
        assert.equal(result.ignoredControls, true);
        assert.equal(result.empty, 0);
      });
      await t.test(
        "snippet scans are shared while history loads and fallback order remains",
        async () => {
          await page.evaluate(() => {
            window.round11BodyNormalizations = 0;
          });
          await page.getByRole("button", { name: "Locate snippet" }).click();
          await page.waitForFunction(() => document.querySelector("#loads").textContent === "1");
          assert.equal(await page.locator("#target").textContent(), "-1");
          const work = await page.evaluate(() => window.round11BodyNormalizations);
          t.diagnostic(`Long body normalizations while loading history: ${work}`);
          assert.ok(work <= 4, `long body normalizations: ${work}`);
          await page.getByRole("button", { name: "Complete history" }).click();
          await page.waitForFunction(() => document.querySelector("#target").textContent === "0");
          await page.waitForFunction(
            () => CSS.highlights.get("zcode-v4-conversation-search-result")?.size === 1,
          );
          assert.equal(await page.locator("#loads").textContent(), "1");
          await page.getByRole("button", { name: "Missing fallback" }).click();
          await page.waitForFunction(() => document.querySelector("#target").textContent === "1");
          await page.waitForFunction(
            () => document.querySelector("#done").textContent === "2",
            undefined,
            { timeout: 5000 },
          );
          await page.getByRole("button", { name: "Run", exact: true }).click();
          await page.getByRole("button", { name: "Locate snippet" }).click();
          assert.equal(await page.locator("#target").textContent(), "-1");
          await page.getByRole("button", { name: "Stop", exact: true }).click();
          await page.waitForFunction(() => document.querySelector("#target").textContent === "0");
        },
      );
      assert.deepEqual(errors, []);
    } finally {
      try {
        await browser?.close();
      } finally {
        try {
          await server?.close();
        } finally {
          const cleanupRoot = resolve(temporaryRoot);
          assert.equal(dirname(cleanupRoot), resolve(tmpdir()));
          assert.ok(basename(cleanupRoot).startsWith("zcodium-performance-round11-find-"));
          await rm(cleanupRoot, { recursive: true, force: true });
        }
      }
    }
  },
);
