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
  "file tree search sends packed index to real Worker with no main-thread round trip",
  { timeout: 60_000 },
  async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const temporaryRoot = await mkdtemp(join(tmpdir(), "zcodium-performance-search-"));
    let server;
    let browser;
    try {
      server = await createServer({
        configFile: false,
        root,
        cacheDir: join(temporaryRoot, "vite-cache"),
        plugins: [react()],
        resolve: {
          alias: [
            {
              find: "@/hooks/useWorkspaceServices.js",
              replacement: resolve(root, "packages/ui/test/performance-search-services.ts"),
            },
            {
              find: "@zcode/shared/workspaceFileEntriesCodec",
              replacement: resolve(root, "packages/ui/test/performance-search-codec.ts"),
            },
            { find: "@", replacement: resolve(root, "packages/ui/src") },
          ],
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
      await page.goto(`${server.resolvedUrls.local[0]}packages/ui/test/performance-search.html`);
      await page.waitForFunction(() =>
        document.querySelector("#paths")?.textContent.includes("/synthetic/a/src/alpha.ts"),
      );
      const initial = await page.evaluate(() => ({ ...window.searchCodecCalls }));
      assert.deepEqual(initial, { pack: 0, unpack: 0 });
      assert.ok((await page.locator("#paths").textContent()).includes("中文\talpha.ts"));
      await page.getByRole("textbox", { name: "File query" }).fill("beta");
      await page.waitForFunction(
        () => document.querySelector("#paths").textContent === "/synthetic/a/src/beta.ts",
      );
      await page.getByRole("textbox", { name: "File query" }).fill("");
      await page.waitForFunction(() => document.querySelector("#paths").textContent === "");
      await page.getByRole("textbox", { name: "File query" }).fill("alpha");
      await page.waitForFunction(() =>
        document.querySelector("#paths").textContent.includes("/synthetic/a/src/alpha.ts"),
      );
      await page.getByRole("button", { name: "Switch root" }).click();
      await page.waitForFunction(() =>
        document.querySelector("#paths").textContent.includes("/synthetic/b/src/alpha.ts"),
      );
      assert.ok(!(await page.locator("#paths").textContent()).includes("/synthetic/a/"));
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await page.waitForFunction(() => document.querySelector("#loading").textContent === "false");
      assert.deepEqual(await page.evaluate(() => ({ ...window.searchCodecCalls })), {
        pack: 0,
        unpack: 0,
      });
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
          assert.ok(basename(cleanupRoot).startsWith("zcodium-performance-search-"));
          await rm(cleanupRoot, { recursive: true, force: true });
        }
      }
    }
  },
);
