// 只连接本脚本创建的隔离页面，CPU 采样用于定位，不用于宣称最终提速。
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = process.argv[2];
if (!output) throw new Error("Usage: node scripts/ci/profile-chat-terminal.mjs <output.json>");
process.env.NODE_ENV = "production";
const omitControlTooltips = process.argv.includes("--omit-control-tooltips");

function summarize(profile) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map();
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) parents.set(child, node.id);
  }
  const self = new Map();
  const inclusive = new Map();
  const functions = new Map();
  const groupedSelf = new Map();
  const groupedInclusive = new Map();
  const frameKey = (id) => {
    const frame = byId.get(id).callFrame;
    const key = `${frame.url}:${frame.lineNumber}:${frame.functionName}`;
    functions.set(key, frame);
    return key;
  };
  for (let index = 0; index < profile.samples.length; index++) {
    let id = profile.samples[index];
    const ms = profile.timeDeltas[index] / 1000;
    self.set(id, (self.get(id) ?? 0) + ms);
    const key = frameKey(id);
    groupedSelf.set(key, (groupedSelf.get(key) ?? 0) + ms);
    const seen = new Set();
    while (id) {
      inclusive.set(id, (inclusive.get(id) ?? 0) + ms);
      const key = frameKey(id);
      if (!seen.has(key)) groupedInclusive.set(key, (groupedInclusive.get(key) ?? 0) + ms);
      seen.add(key);
      id = parents.get(id);
    }
  }
  const top = (values) =>
    [...values.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 55)
      .map(([id, ms]) => {
        const frame = byId.get(id).callFrame;
        return {
          ms: Math.round(ms * 10) / 10,
          name: frame.functionName,
          url: frame.url.replace(/http:\/\/127\.0\.0\.1:\d+\//g, "/"),
          line: frame.lineNumber + 1,
        };
      });
  const grouped = (values, filter = () => true) =>
    [...values.entries()]
      .map(([key, ms]) => ({ ms: Math.round(ms * 10) / 10, ...functions.get(key) }))
      .filter(filter)
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 45);
  return {
    durationMs: (profile.endTime - profile.startTime) / 1000,
    self: top(self),
    inclusive: top(inclusive),
    groupedSelf: grouped(groupedSelf),
    nonReactInclusive: grouped(
      groupedInclusive,
      (row) =>
        row.url &&
        !row.url.includes("react-dom") &&
        !/react[_-]jsx|react\.js|\/chunk-[^/]*react/.test(row.url),
    ),
  };
}

const cacheDir = await mkdtemp(join(tmpdir(), "zcodium-terminal-profile-"));
let server;
let browser;
try {
  server = await createServer({
    configFile: false,
    root,
    cacheDir,
    plugins: [
      {
        name: "terminal-tooltip-cost-probe",
        enforce: "pre",
        async load(id) {
          if (
            !omitControlTooltips ||
            !id.replaceAll("\\", "/").endsWith("/components/ai-elements/code-block.tsx")
          )
            return;
          const source = await readFile(id, "utf8");
          const candidates = [
            ["ControlHintTooltip", 'import { ControlHintTooltip } from "@/ControlHintTooltip.js";'],
            [
              "CodeBlockControlHint",
              'import { CodeBlockControlHint } from "./code-block-tooltip-scope.js";',
            ],
          ];
          const candidate = candidates.find(([, statement]) => source.includes(statement));
          // 诊断加载器必须实际替换控件，避免源码演进后静默变成同一实现的对照。
          assert.ok(candidate, "Tooltip probe did not match the current control import");
          return source.replace(
            candidate[1],
            `const ${candidate[0]} = ({ children }) => children;`,
          );
        },
      },
      react(),
      tailwindcss(),
    ],
    resolve: { alias: { "@": resolve(root, "packages/ui/src") }, dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, hmr: false },
    logLevel: "error",
  });
  await server.listen();
  const base = server.resolvedUrls.local[0];
  const origin = new URL(base).origin;
  browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  const external = [];
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin || ["data:", "blob:"].includes(url.protocol)) await route.continue();
    else {
      external.push(url.href);
      await route.abort();
    }
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}packages/ui/test/performance-chat-code.html?mode=streaming`, {
    waitUntil: "commit",
  });
  await page.waitForFunction(() => window.performanceChatCode?.ready, undefined, {
    timeout: 60_000,
  });
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
  const session = await context.newCDPSession(page);
  await session.send("Profiler.enable");
  const stages = [];
  for (const action of ["completeStream", "moveToHistory"]) {
    await session.send("Profiler.start");
    const measurement = await page.evaluate(async (method) => {
      const tasks = [];
      const observer = new PerformanceObserver((list) => tasks.push(...list.getEntries()));
      observer.observe({ type: "longtask" });
      const start = performance.now();
      window.performanceChatCode[method]();
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      tasks.push(...observer.takeRecords());
      observer.disconnect();
      return {
        twoFramesMs: performance.now() - start,
        commit: window.performanceChatCode.measures.at(-1),
        longTasks: tasks.filter((entry) => entry.startTime >= start).map((entry) => entry.duration),
      };
    }, action);
    const { profile } = await session.send("Profiler.stop");
    stages.push({ action, measurement, profile: summarize(profile) });
    console.log(
      JSON.stringify({
        action,
        measurement,
        top: stages.at(-1).profile.nonReactInclusive.slice(0, 8),
      }),
    );
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        omitControlTooltips,
        browser: browser.version(),
        stages,
        errors,
        external,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await browser?.close();
  await server?.close();
  await rm(cacheDir, { recursive: true, force: true });
}
