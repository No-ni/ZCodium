import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../../", import.meta.url));
const baseline = process.argv.includes("--baseline");
const reportArg = process.argv.find((arg) => arg.startsWith("--report="))?.slice(9);
const compareArg = process.argv.find((arg) => arg.startsWith("--compare="))?.slice(10);
const samples = [
  ["javascript", 'const greeting = "中文";\nconsole.log(greeting);'],
  ["typescript", 'interface Value { text: string };\nconst value: Value = { text: "hi" };'],
  ["tsx", 'export const View = () => <div title="hi">Hello</div>;'],
  ["python", 'def hello(name: str):\n    return f"Hello {name}"'],
  ["shellscript", 'for name in a b; do\n  echo "$name"\ndone'],
  ["json", '{ "name": "test", "count": 12, "ready": true }'],
  ["yaml", "name: test\nitems:\n  - enabled: true"],
  ["css", ".hello { color: red; width: calc(100% - 2px); }"],
  ["html", "<style>p { color: red; }</style><p>Hello</p><script>const a = 1;</script>"],
  ["markdown", "# Hello\n\n**bold** and `code`\n\n```typescript\nconst a: number = 1;\n```"],
  [
    "vue",
    '<script setup lang="ts">const a: number = 1;</script>\n<template><p>{{ a }}</p></template>',
  ],
  ["rust", 'fn main() { let values = vec![1, 2]; println!("{:?}", values); }'],
];

test(
  "real Shiki shares the renderer engine with equivalent multi-language tokens",
  { timeout: 120_000 },
  async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "zcodium-shiki-vite-"));
    let server;
    let browser;
    const blockedRequests = [];
    const errors = [];
    try {
      server = await createServer({
        configFile: false,
        root,
        cacheDir,
        resolve: { alias: { "@": resolve(root, "packages/ui/src") } },
        optimizeDeps: { entries: ["packages/ui/src/lib/shikiHighlighter.ts"] },
        plugins: [
          {
            name: "isolated-shiki-probe",
            configureServer(server) {
              server.middlewares.use((req, res, next) => {
                if (req.url !== "/__shiki_probe") return next();
                res.setHeader("Content-Type", "text/html");
                res.end(
                  '<!doctype html><html><head><link rel="icon" href="data:,"></head><body>Isolated syntax probe</body></html>',
                );
              });
            },
          },
        ],
        server: { host: "127.0.0.1", port: 0, hmr: false },
        logLevel: "error",
      });
      await server.listen();
      const baseUrl = server.resolvedUrls.local[0];
      const origin = new URL(baseUrl).origin;
      browser = await chromium.launch({
        channel: process.platform === "win32" ? "msedge" : "chrome",
        headless: true,
      });
      const context = await browser.newContext();
      await context.route("**/*", (route) => {
        const url = route.request().url();
        if (new URL(url).origin === origin) return route.continue();
        blockedRequests.push(url);
        return route.abort();
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await page.goto(`${origin}/__shiki_probe`);
      await page.evaluate(async () => {
        window.probeHighlight = (
          await import("/packages/ui/src/lib/shikiHighlighter.ts")
        ).highlightCode;
        window.probeDiagnostics = (
          await import("/packages/ui/src/lib/memoryDiagnostics.ts")
        ).uiMemoryDiagnosticsRegistry;
      });
      const cdp = await context.newCDPSession(page);
      const heap = async () => {
        await cdp.send("HeapProfiler.collectGarbage");
        return (await cdp.send("Runtime.getHeapUsage")).usedSize;
      };
      const beforeHeap = await heap();
      const result = await page.evaluate(async (samples) => {
        const startedAt = performance.now();
        const outputs = [];
        for (const theme of ["github-dark", "github-light"]) {
          for (const [language, code] of samples) {
            const result = await new Promise((resolve) =>
              window.probeHighlight(code, language, theme, resolve),
            );
            if (
              result.tokens
                .map((line) => line.map((token) => token.content).join(""))
                .join("\n") !== code
            ) {
              throw new Error(`Changed source: ${language}/${theme}`);
            }
            outputs.push({ language, theme, result });
          }
        }
        return {
          outputs,
          durationMs: performance.now() - startedAt,
          counters: window.probeDiagnostics.collect(),
        };
      }, samples);
      const afterHeap = await heap();
      // 交错主题、并发新代码，确认共享引擎内部的当前主题不会串色。
      await page.evaluate(
        async ({ samples, outputs }) => {
          for (let round = 0; round < 3; round++) {
            await Promise.all(
              samples.flatMap(([language, code]) =>
                ["github-light", "github-dark"].map(async (theme) => {
                  const result = await new Promise((resolve) =>
                    window.probeHighlight(
                      `${code}\n${" ".repeat(round + 1)}`,
                      language,
                      theme,
                      resolve,
                    ),
                  );
                  const expected = outputs.find(
                    (output) => output.language === language && output.theme === theme,
                  ).result;
                  if (
                    result.fg !== expected.fg ||
                    JSON.stringify(result.tokens.slice(0, code.split("\n").length)) !==
                      JSON.stringify(expected.tokens)
                  ) {
                    throw new Error(`Concurrent token mismatch: ${language}/${theme}`);
                  }
                }),
              ),
            );
          }
        },
        { samples, outputs: result.outputs },
      );
      const repeatedHeap = await heap();
      const hashes = result.outputs.map(({ language, theme, result }) => ({
        language,
        theme,
        sha256: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
      }));
      const counters = await page.evaluate(() => window.probeDiagnostics.collect());
      const report = {
        mode: baseline ? "before" : "after",
        browser: browser.version(),
        samples: samples.length,
        themes: 2,
        beforeHeap,
        afterHeap,
        heapGrowth: afterHeap - beforeHeap,
        repeatedHeap,
        durationMs: result.durationMs,
        counters,
        hashes,
        errors,
        blockedRequests,
      };
      console.log(JSON.stringify(report));
      if (reportArg) {
        const reportPath = resolve(root, reportArg);
        assert.ok(reportPath.startsWith(resolve(root, "docs/performance") + sep));
        await mkdir(dirname(reportPath), { recursive: true });
        await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      }
      if (compareArg)
        assert.deepEqual(
          hashes,
          JSON.parse(await readFile(resolve(root, compareArg), "utf8")).hashes,
        );
      assert.deepEqual(errors, []);
      assert.deepEqual(blockedRequests, []);
      assert.equal(counters["shiki.pending"], 0);
      if (!baseline) {
        assert.equal(counters["shiki.highlighters"], samples.length);
        assert.equal(counters["shiki.pendingResources"], 0);
      }
    } finally {
      await browser?.close();
      await server?.close();
      const cleanupPath = relative(tmpdir(), cacheDir);
      assert.ok(cleanupPath.startsWith("zcodium-shiki-vite-") && !cleanupPath.includes(sep));
      await rm(cacheDir, { recursive: true, force: true });
    }
  },
);
