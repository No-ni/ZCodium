// 同一脏工作区内仅替换两个展示入口做 A/B，不覆盖源码、不启动桌面或模型。
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../../", import.meta.url));
const baselineDir = process.argv[2];
const outputFile = process.argv[3];
if (!baselineDir || !outputFile) {
  throw new Error(
    "Usage: node scripts/ci/measure-chat-code-rendering.mjs <baseline-source-dir> <output.json>",
  );
}
const baselineSources = new Map(
  await Promise.all(
    ["code-block.tsx", "message.tsx"].map(async (name) => [
      resolve(root, "packages/ui/src/components/ai-elements", name).replaceAll("\\", "/"),
      await readFile(join(baselineDir, name), "utf8"),
    ]),
  ),
);
const browser = await chromium.launch({
  channel: process.platform === "win32" ? "msedge" : "chrome",
  headless: true,
});
const results = [];
try {
  for (const variant of ["before", "after"]) {
    const cacheDir = await mkdtemp(join(tmpdir(), "zcodium-chat-code-ab-"));
    let server;
    let context;
    try {
      server = await createServer({
        configFile: false,
        root,
        cacheDir,
        plugins: [
          {
            name: "chat-code-before-source",
            enforce: "pre",
            load(id) {
              if (variant === "before") return baselineSources.get(id.replaceAll("\\", "/"));
            },
          },
          react(),
          tailwindcss(),
        ],
        resolve: {
          alias: { "@": resolve(root, "packages/ui/src") },
          dedupe: ["react", "react-dom"],
        },
        server: { host: "127.0.0.1", port: 0, hmr: false },
        logLevel: "error",
      });
      await server.listen();
      const base = server.resolvedUrls.local[0];
      const origin = new URL(base).origin;
      context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const errors = [];
      const external = [];
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === origin || ["data:", "blob:"].includes(url.protocol)) {
          await route.continue();
        } else {
          external.push(url.href);
          await route.abort();
        }
      });
      for (let trial = 0; trial < 3; trial++) {
        const page = await context.newPage();
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${base}packages/ui/test/performance-chat-code.html?mode=streaming`, {
          waitUntil: "commit",
        });
        await page.waitForFunction(() => window.performanceChatCode?.ready, undefined, {
          timeout: 60_000,
        });
        const cold = await page.evaluate(() => window.performanceChatCode.measures[0]);
        const transitions = [];
        for (const action of ["completeStream", "moveToHistory"]) {
          transitions.push(
            await page.evaluate(async (method) => {
              const tasks = [];
              const observer = new PerformanceObserver((list) => tasks.push(...list.getEntries()));
              observer.observe({ type: "longtask" });
              const started = performance.now();
              window.performanceChatCode[method]();
              await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
              const twoFramesMs = performance.now() - started;
              tasks.push(...observer.takeRecords());
              observer.disconnect();
              return {
                action: method,
                twoFramesMs,
                commit: window.performanceChatCode.measures.at(-1),
                longTasksMs: tasks
                  .filter((entry) => entry.startTime >= started)
                  .map((entry) => entry.duration),
              };
            }, action),
          );
        }
        if (variant === "after") {
          await page.locator("[data-code-snippet-highlight]").first().waitFor();
        }
        // 诊断遍历在计时区间之外，避免 getBoundingClientRect 把自己的成本算给转换。
        const resources = await page.evaluate(() => window.performanceChatCode.snapshot());
        if (variant === "after") {
          assert.equal(resources.snippets, 240);
          assert.equal(resources.shadowRootCount, 0);
          assert.equal(resources.viewerContainerCount, 0);
          assert.ok(resources.highlights < 32);
        } else {
          assert.ok(resources.shadowRootCount >= 240, JSON.stringify(resources));
        }
        results.push({ variant, trial: trial + 1, cold, transitions, resources });
        console.log(JSON.stringify(results.at(-1)));
        await page.close();
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
    } finally {
      await context?.close();
      await server?.close();
      await rm(cacheDir, { recursive: true, force: true });
    }
  }
  await writeFile(
    outputFile,
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        baselineFiles: [...baselineSources.keys()].map((path) => basename(path)),
        browserVersion: browser.version(),
        viewport: { width: 1280, height: 900 },
        payloadChars: 34122,
        fences: 240,
        results,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await browser.close();
}
