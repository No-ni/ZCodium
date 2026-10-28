// 真实浏览器交互回归，使用受控 Host 夹具；不启动用户 Agent、不读取用户数据库。
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
  "performance UI: search races, directory virtualization, local clock and lazy entries",
  { timeout: 60_000 },
  async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const temporaryRoot = await mkdtemp(join(tmpdir(), "zcodium-performance-ui-"));
    let server;
    let browser;
    try {
      server = await createServer({
        configFile: false,
        root,
        // 全套检查中扫描整个仓库和共享缓存会拖住导航；每个 server 只准备自己的夹具依赖。
        cacheDir: join(temporaryRoot, "vite-cache"),
        optimizeDeps: { entries: [resolve(root, "packages/ui/test/performance-browser.html")] },
        plugins: [react()],
        resolve: {
          alias: { "@": resolve(root, "packages/ui/src") },
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
      const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
      const failures = [];
      const urls = [];
      page.on("pageerror", (error) => failures.push(error.message));
      page.on("request", (request) => urls.push(request.url()));
      await page.goto(`${server.resolvedUrls.local[0]}packages/ui/test/performance-browser.html`);
      await page.getByRole("textbox", { name: "Search" }).waitFor();
      await page.getByRole("textbox", { name: "Search" }).fill("older");
      await page.getByRole("textbox", { name: "Search" }).fill("newer");
      await page.evaluate(() => window.performanceFixture.complete("newer"));
      await page.waitForFunction(() => document.querySelector("#files").textContent === "newer");
      await page.evaluate(() => window.performanceFixture.complete("older"));
      assert.equal(await page.locator("#files").textContent(), "newer");
      await page.getByRole("textbox", { name: "Search" }).fill("alpha beta");
      await page.evaluate(() =>
        window.performanceFixture.complete("alpha beta", [
          {
            name: "alpha_beta.ts",
            path: "C:/synthetic/alpha_beta.ts",
            relativePath: "src/ALPHA_beta.ts",
            type: "file",
          },
          {
            name: "alphabet.ts",
            path: "C:/synthetic/alphabet.ts",
            relativePath: "src/alphabet.ts",
            type: "file",
          },
          {
            name: "alpha beta",
            path: "C:/synthetic/folder",
            relativePath: "alpha beta",
            type: "directory",
          },
        ]),
      );
      await page.waitForFunction(() => document.querySelector("#loading").textContent === "false");
      assert.equal(await page.locator("#files").textContent(), "alpha_beta.ts");
      await page.getByRole("textbox", { name: "Search" }).fill("scoped");
      await page.getByRole("button", { name: "Switch scope" }).click();
      await page.evaluate(() =>
        window.performanceFixture.complete(
          "scoped",
          [
            {
              name: "scoped-new.ts",
              path: "C:/synthetic/new.ts",
              relativePath: "scoped-new.ts",
              type: "file",
            },
          ],
          "remote-b",
        ),
      );
      await page.waitForFunction(
        () => document.querySelector("#files").textContent === "scoped-new.ts",
      );
      await page.evaluate(() => window.performanceFixture.complete("scoped"));
      assert.equal(await page.locator("#files").textContent(), "scoped-new.ts");
      await page.getByRole("textbox", { name: "Search" }).fill("closed");
      await page.getByRole("button", { name: "Toggle search" }).click();
      await page.evaluate(() =>
        window.performanceFixture.complete("closed", undefined, "remote-b"),
      );
      await page.waitForFunction(() => document.querySelector("#files").textContent === "");

      const nav = page.getByRole("navigation");
      await page.waitForFunction(
        () => Number(document.querySelector("nav")?.getAttribute("data-rendered-item-count")) > 0,
      );
      assert.equal(await nav.getAttribute("data-item-count"), "1000");
      assert.ok(Number(await nav.getAttribute("data-rendered-item-count")) < 80);
      await nav.locator("button").first().focus();
      await page.keyboard.press("Enter");
      assert.match(await page.locator("#jump").textContent(), /^\d+:-1$/);
      const renders = await page.locator("#outer-renders").textContent();
      const duration = Number(await page.locator("#duration").textContent());
      await page.waitForFunction(
        (previous) => Number(document.querySelector("#duration").textContent) > previous,
        duration,
      );
      assert.equal(await page.locator("#outer-renders").textContent(), renders);
      assert.ok(
        !urls.some((url) =>
          /\/SettingsPage\.tsx(?:\?|$)|\/TerminalSession\.tsx(?:\?|$)|\/xterm\.js/.test(url),
        ),
        "heavy implementations must not load with lazy entry modules",
      );
      assert.deepEqual(failures, []);
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

test(
  "DOCX preview: callback updates and stale render completion",
  { timeout: 60_000 },
  async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const temporaryRoot = await mkdtemp(join(tmpdir(), "zcodium-performance-docx-"));
    let server;
    let browser;
    try {
      server = await createServer({
        configFile: false,
        root,
        cacheDir: join(temporaryRoot, "vite-cache"),
        optimizeDeps: {
          entries: [resolve(root, "packages/ui/test/frontend-preview-fixture.html")],
        },
        plugins: [react()],
        resolve: {
          alias: [
            { find: "@", replacement: resolve(root, "packages/ui/src") },
            {
              find: /^docx-preview$/,
              replacement: resolve(root, "packages/ui/test/frontend-preview-renderer.ts"),
            },
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
      const failures = [];
      page.on("pageerror", (error) => failures.push(error.message));
      await page.goto(
        `${server.resolvedUrls.local[0]}packages/ui/test/frontend-preview-fixture.html`,
      );
      await page.waitForFunction(() => window.frontendPreviewFixture?.renderCount === 1);
      const flushEffects = () =>
        page.evaluate(
          () =>
            new Promise((done) => {
              requestAnimationFrame(() => requestAnimationFrame(done));
            }),
        );
      await page.getByRole("button", { name: "Change callback" }).click();
      await flushEffects();
      assert.equal(await page.evaluate(() => window.frontendPreviewFixture.renderCount), 1);
      await page.evaluate(() => window.frontendPreviewFixture.complete(0, "first document"));
      await page.getByText("first document", { exact: true }).waitFor();
      await page.getByRole("link", { name: "Document link" }).click();
      assert.equal(
        await page.locator("#docx-opened-links").textContent(),
        "1:https://example.com/docx",
      );
      await flushEffects();
      assert.equal(await page.evaluate(() => window.frontendPreviewFixture.renderCount), 1);

      await page.getByRole("button", { name: "Toggle link callback" }).click();
      await page.getByRole("link", { name: "Document link" }).click();
      assert.equal(
        await page.locator("#docx-opened-links").textContent(),
        "1:https://example.com/docx",
      );
      assert.ok(page.url().endsWith("frontend-preview-fixture.html"));
      await page.getByRole("button", { name: "Toggle link callback" }).click();
      await page.getByRole("button", { name: "Change callback" }).click();
      await page.getByRole("link", { name: "Document link" }).click();
      assert.equal(
        await page.locator("#docx-opened-links").textContent(),
        "1:https://example.com/docx,2:https://example.com/docx",
      );
      await flushEffects();
      assert.equal(await page.evaluate(() => window.frontendPreviewFixture.renderCount), 1);

      await page.getByRole("button", { name: "Change buffer" }).click();
      await page.waitForFunction(() => window.frontendPreviewFixture.renderCount === 2);
      await page.getByRole("button", { name: "Change path" }).click();
      await page.waitForFunction(() => window.frontendPreviewFixture.renderCount === 3);
      await page.evaluate(() => window.frontendPreviewFixture.complete(2, "current document"));
      await page.getByText("current document", { exact: true }).waitFor();
      await page.evaluate(() => window.frontendPreviewFixture.complete(1, "stale document"));
      await flushEffects();
      assert.equal(
        await page.locator("[data-frontend-docx-content]").textContent(),
        "current document",
      );

      await page.getByRole("button", { name: "Change buffer" }).click();
      await page.waitForFunction(() => window.frontendPreviewFixture.renderCount === 4);
      await page.getByRole("button", { name: "Unmount preview" }).click();
      await page.evaluate(() => window.frontendPreviewFixture.complete(3, "unmounted document"));
      await flushEffects();
      assert.equal(await page.locator("#docx-container").textContent(), "");
      assert.deepEqual(failures, []);
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
