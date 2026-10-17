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
  "conversation find: snapshot replacement, history position, streaming and comments",
  { timeout: 60_000 },
  async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const temporaryRoot = await mkdtemp(join(tmpdir(), "zcodium-performance-find-"));
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
      await page.goto(`${server.resolvedUrls.local[0]}packages/ui/test/performance-find.html`);
      const count = async (expected) => {
        await page.waitForFunction(
          (value) => document.querySelector("#matches")?.textContent === String(value),
          expected,
          { timeout: 5000 },
        );
        assert.equal(await page.locator("#matches").textContent(), String(expected));
      };
      await count(1);
      await page.getByRole("button", { name: "Replace snapshot" }).click();
      await count(0);
      await page.getByRole("textbox", { name: "Find", exact: true }).fill("beta");
      await count(2);
      await page.getByRole("textbox", { name: "Find", exact: true }).fill("");
      await count(0);
      await page.getByRole("button", { name: "Reset", exact: true }).click();
      await page.getByRole("textbox", { name: "Find", exact: true }).fill("alpha");
      await count(1);
      const historyReads = await page.locator("#initial-body-reads").textContent();
      await page.getByRole("button", { name: "Prepend history" }).click();
      await count(2);
      assert.equal(await page.locator("#initial-body-reads").textContent(), historyReads);
      await page.waitForFunction(
        () =>
          document.querySelector("#active").textContent === "1" &&
          document.querySelector("#target").textContent === "1",
      );
      await page.getByRole("button", { name: "Reset", exact: true }).click();
      await count(1);
      await page.getByRole("button", { name: "Streaming update" }).click();
      await count(2);
      await page.getByRole("button", { name: "Comment", exact: true }).click();
      await page.getByRole("textbox", { name: "Find", exact: true }).fill("secret");
      await count(1);
      await page.getByRole("button", { name: "Toggle comments" }).click();
      await count(0);
      await page.getByRole("button", { name: "Toggle comments" }).click();
      await count(1);
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
          assert.ok(basename(cleanupRoot).startsWith("zcodium-performance-find-"));
          await rm(cleanupRoot, { recursive: true, force: true });
        }
      }
    }
  },
);
