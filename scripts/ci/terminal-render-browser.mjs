import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { build } from "vite";

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

export function roundMs(value) {
  return Math.round(value * 1000) / 1000;
}

function createSourceReplacementPlugin(variant, baselineSources, loadHits) {
  return {
    name: "terminal-render-baseline-source",
    enforce: "pre",
    load(id) {
      if (variant !== "before") return undefined;
      const key = id.split("?")[0].replaceAll("\\", "/");
      if (!baselineSources.has(key)) return undefined;
      const fileName = key.slice(key.lastIndexOf("/") + 1);
      loadHits[fileName] += 1;
      return baselineSources.get(key);
    },
  };
}

export async function buildFixture({ variant, root, fixturePath, tempRoot, baselineSources }) {
  const buildDir = join(tempRoot, variant + "-build");
  const baselineReplacementLoadHits = Object.fromEntries(
    [...baselineSources.keys()].map((key) => [key.slice(key.lastIndexOf("/") + 1), 0]),
  );
  await build({
    configFile: false,
    root,
    mode: "production",
    cacheDir: join(tempRoot, variant + "-vite-cache"),
    plugins: [
      createSourceReplacementPlugin(variant, baselineSources, baselineReplacementLoadHits),
      react(),
      tailwindcss(),
    ],
    resolve: {
      alias: { "@": resolve(root, "packages/ui/src") },
      dedupe: ["react", "react-dom"],
    },
    build: {
      outDir: buildDir,
      emptyOutDir: true,
      rollupOptions: { input: resolve(root, fixturePath) },
    },
    logLevel: "error",
  });

  if (variant === "before") {
    const expectedFiles = Object.keys(baselineReplacementLoadHits).sort();
    const loadedFiles = Object.entries(baselineReplacementLoadHits)
      .filter(([, count]) => count > 0)
      .map(([fileName]) => fileName)
      .sort();
    assert.deepEqual(
      loadedFiles,
      expectedFiles,
      "Baseline source replacement did not load both files",
    );
  }

  return {
    buildDir,
    baselineReplacementLoadHits: variant === "before" ? baselineReplacementLoadHits : null,
  };
}

export async function startStaticServer(buildDir) {
  const server = createHttpServer(async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end();
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    } catch {
      response.writeHead(400).end();
      return;
    }

    const target = resolve(buildDir, "." + pathname.replaceAll("/", sep));
    const relativeTarget = relative(buildDir, target);
    if (relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
      response.writeHead(403).end();
      return;
    }

    try {
      const body = await readFile(target);
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Length": body.byteLength,
        "Content-Type": mimeTypes.get(extname(target).toLowerCase()) ?? "application/octet-stream",
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch {
      response.writeHead(404).end();
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, baseUrl: "http://127.0.0.1:" + address.port + "/" };
}

export function closeServer(server) {
  return new Promise((resolveClose) => {
    server.close(() => resolveClose());
    server.closeAllConnections?.();
  });
}

async function readMetrics(session) {
  const response = await session.send("Performance.getMetrics");
  return new Map(response.metrics.map((metric) => [metric.name, metric.value]));
}

function metricDeltaMs(before, after, metricNames) {
  return Object.fromEntries(
    metricNames.map((name) => {
      const start = before.get(name);
      const end = after.get(name);
      return [
        name,
        start === undefined || end === undefined
          ? null
          : roundMs(Math.max(0, (end - start) * 1000)),
      ];
    }),
  );
}

export async function waitForFixture(page) {
  await page.waitForFunction(() => window.performanceChatCode?.ready === true, undefined, {
    timeout: 60_000,
  });
  await page.waitForFunction(
    () => window.performanceChatCode?.snapshot().snippets === 240,
    undefined,
    { timeout: 60_000 },
  );
  const fixture = await page.evaluate(() => ({
    payloadLength: window.performanceChatCode.payloadLength,
    blockCount: window.performanceChatCode.blockCount,
    cold: window.performanceChatCode.measures[0],
  }));
  assert.equal(fixture.payloadLength, 34_122);
  assert.equal(fixture.blockCount, 240);
  assert.equal(fixture.cold?.name, "cold-mount");
  return fixture.cold;
}

async function measureTransition(page, session, action, highlightRootSelector, metricNames) {
  const expectedCommit = action === "completeStream" ? "terminal" : "history-reparent";
  const beforeMetrics = await readMetrics(session);
  await page.evaluate(
    ({ action, expectedCommit, highlightRootSelector }) => {
      const api = window.performanceChatCode;
      const initialMeasureCount = api.measures.length;
      const startedAt = performance.now();
      const longTasks = [];
      const longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTasks.push({ startTime: entry.startTime, duration: entry.duration });
        }
      });
      longTaskObserver.observe({ type: "longtask" });

      const twoRafPromise = new Promise((resolveTwoRaf) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolveTwoRaf(performance.now() - startedAt));
        });
      });

      const commitPromise = new Promise((resolveCommit, rejectCommit) => {
        const deadline = startedAt + 60_000;
        const checkCommit = () => {
          const latest = api.measures.at(-1);
          if (api.measures.length > initialMeasureCount && latest?.name === expectedCommit) {
            resolveCommit(latest);
          } else if (performance.now() >= deadline) {
            rejectCommit(new Error("Timed out waiting for " + expectedCommit + " commit"));
          } else {
            requestAnimationFrame(checkCommit);
          }
        };
        requestAnimationFrame(checkCommit);
      });

      const resultPromise = (async () => {
        await commitPromise;
        const highlightAt = await new Promise((resolveHighlight, rejectHighlight) => {
          const findHighlight = () =>
            document.querySelector(highlightRootSelector + " [data-code-snippet-highlight]");
          const current = findHighlight();
          if (current) {
            resolveHighlight(performance.now());
            return;
          }

          const target = document.getElementById("message-scroll") ?? document.body;
          const observer = new MutationObserver(() => {
            if (findHighlight()) {
              observer.disconnect();
              clearTimeout(timeout);
              resolveHighlight(performance.now());
            }
          });
          const timeout = setTimeout(() => {
            observer.disconnect();
            rejectHighlight(new Error("Timed out waiting for visible code highlight"));
          }, 60_000);
          observer.observe(target, { childList: true, subtree: true });
          if (findHighlight()) {
            observer.disconnect();
            clearTimeout(timeout);
            resolveHighlight(performance.now());
          }
        });
        const firstVisibleHighlightMs = highlightAt - startedAt;

        await new Promise((resolveFrames) => {
          requestAnimationFrame(() => requestAnimationFrame(resolveFrames));
        });
        for (const entry of longTaskObserver.takeRecords()) {
          longTasks.push({ startTime: entry.startTime, duration: entry.duration });
        }
        longTaskObserver.disconnect();
        return {
          commit: api.measures.at(-1),
          firstVisibleHighlightMs,
          twoRafMs: await twoRafPromise,
          longTasksMs: longTasks
            .filter((entry) => entry.startTime >= startedAt)
            .map((entry) => Math.round(entry.duration * 1000) / 1000),
        };
      })();

      window.__terminalRenderMeasurement = resultPromise;
      api[action]();
    },
    { action, expectedCommit, highlightRootSelector },
  );

  const result = await page.evaluate(async () => await window.__terminalRenderMeasurement);
  const afterMetrics = await readMetrics(session);
  return {
    commitName: result.commit.name,
    commitMs: result.commit.commitMs,
    firstVisibleHighlightMs: roundMs(result.firstVisibleHighlightMs),
    twoRafMs: roundMs(result.twoRafMs),
    longTasksMs: result.longTasksMs,
    performanceDeltaMs: metricDeltaMs(beforeMetrics, afterMetrics, metricNames),
  };
}

export async function runPageTrial({
  context,
  baseUrl,
  fixturePath,
  blockedRequests,
  pageErrors,
  variant,
  trial,
  metricNames,
}) {
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  page.setDefaultNavigationTimeout(60_000);
  const origin = new URL(baseUrl).origin;
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin || ["data:", "blob:"].includes(url.protocol)) {
      await route.continue();
    } else {
      blockedRequests.push(url.href);
      await route.abort();
    }
  });
  page.on("pageerror", (error) => pageErrors.push({ variant, trial, message: error.message }));

  try {
    await page.goto(new URL(fixturePath + "?mode=streaming", baseUrl).href, {
      waitUntil: "load",
    });
    const cold = await waitForFixture(page);
    const streamingState = await page.evaluate(() => {
      const root = document.querySelector("#live-tail-root");
      return {
        mode: document.querySelector("#fixture-controls")?.textContent?.includes("streaming"),
        codeBlocks: root?.querySelectorAll("[data-code-snippet]").length ?? 0,
        sourceElements: root?.querySelectorAll("[data-code-snippet-source]").length ?? 0,
        highlights: root?.querySelectorAll("[data-code-snippet-highlight]").length ?? 0,
      };
    });
    assert.equal(streamingState.mode, true);
    assert.equal(streamingState.codeBlocks, 240);
    assert.equal(streamingState.sourceElements, 240);
    assert.equal(streamingState.highlights, 0);

    const session = await context.newCDPSession(page);
    await session.send("Performance.enable");
    const terminal = await measureTransition(
      page,
      session,
      "completeStream",
      "#live-tail-root",
      metricNames,
    );
    assert.equal(terminal.commitName, "terminal");
    const terminalState = await page.evaluate(() => {
      const root = document.querySelector("#live-tail-root");
      return {
        codeBlocks: root?.querySelectorAll("[data-code-snippet]").length ?? 0,
        sourceElements: root?.querySelectorAll("[data-code-snippet-source]").length ?? 0,
        highlights: root?.querySelectorAll("[data-code-snippet-highlight]").length ?? 0,
      };
    });
    assert.equal(terminalState.codeBlocks, 240);
    assert.equal(terminalState.sourceElements, 240);
    assert.ok(terminalState.highlights > 0, JSON.stringify(terminalState));

    const history = await measureTransition(
      page,
      session,
      "moveToHistory",
      "#history-root",
      metricNames,
    );
    assert.equal(history.commitName, "history-reparent");
    const historyState = await page.evaluate(() => {
      const historyRoot = document.querySelector("#history-root");
      const liveTailRoot = document.querySelector("#live-tail-root");
      return {
        historyRows: historyRoot?.querySelectorAll("[data-row-id]").length ?? 0,
        historyCodeBlocks: historyRoot?.querySelectorAll("[data-code-snippet]").length ?? 0,
        historySources: historyRoot?.querySelectorAll("[data-code-snippet-source]").length ?? 0,
        historyHighlights:
          historyRoot?.querySelectorAll("[data-code-snippet-highlight]").length ?? 0,
        liveTailRows: liveTailRoot?.querySelectorAll("[data-row-id]").length ?? 0,
        liveTailHighlights:
          liveTailRoot?.querySelectorAll("[data-code-snippet-highlight]").length ?? 0,
      };
    });
    assert.equal(historyState.historyRows, 1);
    assert.equal(historyState.historyCodeBlocks, 240);
    assert.equal(historyState.historySources, 240);
    assert.ok(historyState.historyHighlights > 0, JSON.stringify(historyState));
    assert.equal(historyState.liveTailRows, 0);
    assert.equal(historyState.liveTailHighlights, 0);
    await session.detach();
    return { variant, trial, cold, streamingState, terminal, terminalState, history, historyState };
  } finally {
    await page.close();
  }
}
