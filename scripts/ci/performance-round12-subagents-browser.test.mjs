import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright-core";
import { createServer } from "vite";

async function findRandomLoopbackPort() {
  const probe = createTcpServer();
  try {
    await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", resolve);
    });
    const address = probe.address();
    if (!address || typeof address === "string") {
      throw new Error("Could not resolve a random loopback port");
    }
    return address.port;
  } finally {
    if (probe.listening) {
      await new Promise((resolve, reject) => {
        probe.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
}

test(
  "subagent directory stops stale pagination after unmount and preserves refresh results",
  { timeout: 90_000 },
  async (t) => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const profileDirectory = await mkdtemp(
      join(tmpdir(), "zcodium-performance-round12-subagents-edge-"),
    );
    let server;
    let context;
    try {
      const port = await findRandomLoopbackPort();
      server = await createServer({
        configFile: false,
        root,
        cacheDir: join(profileDirectory, "vite-cache"),
        plugins: [react()],
        resolve: {
          alias: { "@": resolve(root, "packages/ui/src") },
          dedupe: ["react", "react-dom"],
        },
        optimizeDeps: {
          entries: [resolve(root, "packages/ui/test/performance-round12-subagents.html")],
        },
        server: { host: "127.0.0.1", port, strictPort: true },
        logLevel: "error",
      });
      await server.listen();
      context = await chromium.launchPersistentContext(profileDirectory, {
        channel: process.platform === "win32" ? "msedge" : "chrome",
        headless: true,
      });
      const page = context.pages()[0] ?? (await context.newPage());
      const pageErrors = [];
      const requests = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      page.on("request", (request) => requests.push(request.url()));
      const baseUrl = server.resolvedUrls.local[0];
      const fixtureUrl = `${baseUrl}packages/ui/test/performance-round12-subagents.html`;
      const fixtureResponse = await fetch(fixtureUrl, { signal: AbortSignal.timeout(10_000) });
      t.diagnostic(
        `Vite address ${JSON.stringify(server.httpServer.address())}; fixture HTTP ${fixtureResponse.status}`,
      );
      assert.equal(fixtureResponse.status, 200);
      await page.goto(fixtureUrl, {
        waitUntil: "domcontentloaded",
      });
      await page.getByRole("button", { name: "Load 20" }).waitFor();

      const waitForCount = async (count) => {
        await page.waitForFunction(
          (expected) =>
            Number(document.querySelector("#directory")?.getAttribute("data-count")) === expected,
          count,
        );
      };
      const loadTo140 = async () => {
        await waitForCount(20);
        for (let count = 40; count <= 140; count += 20) {
          await page.getByRole("button", { name: "Load 20" }).click();
          await waitForCount(count);
        }
      };
      const reopenAndLoadTo140 = async () => {
        await page.getByRole("button", { name: "Open directory" }).click();
        await loadTo140();
      };
      const closeAndResolve = async () => {
        await page.getByRole("button", { name: "Close directory" }).click();
        await page.locator("#directory").waitFor({ state: "detached" });
        await page.evaluate(async () => {
          window.performanceRound12Subagents.resolveNext();
          await new Promise((resolveFrame) =>
            requestAnimationFrame(() => requestAnimationFrame(resolveFrame)),
          );
        });
      };

      await loadTo140();
      await page.evaluate(() => window.performanceRound12Subagents.defer("first"));
      const firstPageStart = await page.evaluate(
        () => window.performanceRound12Subagents.calls().length,
      );
      await page.getByRole("button", { name: "Refresh" }).click();
      await page.waitForFunction(() => window.performanceRound12Subagents.pendingCount() === 1);
      const firstPagePendingCalls = await page.evaluate(
        () => window.performanceRound12Subagents.calls().length,
      );
      await closeAndResolve();
      const firstPageFollowups = await page.evaluate(
        (start) => window.performanceRound12Subagents.calls().length - start,
        firstPagePendingCalls,
      );
      t.diagnostic(
        `first-page unmount: ${firstPageFollowups} follow-up RPCs after ${
          firstPagePendingCalls - firstPageStart
        } refresh RPC`,
      );

      await reopenAndLoadTo140();
      await page.evaluate(() => window.performanceRound12Subagents.defer("100"));
      await page.getByRole("button", { name: "Refresh" }).click();
      await page.waitForFunction(() => window.performanceRound12Subagents.pendingCount() === 1);
      const secondPagePendingCalls = await page.evaluate(
        () => window.performanceRound12Subagents.calls().length,
      );
      await closeAndResolve();
      const secondPageFollowups = await page.evaluate(
        (start) => window.performanceRound12Subagents.calls().length - start,
        secondPagePendingCalls,
      );
      t.diagnostic(`second-page unmount: ${secondPageFollowups} follow-up RPCs`);

      await reopenAndLoadTo140();
      const expectedIds = Array.from({ length: 140 }, (_, index) => `child-${index}`).join(",");
      assert.equal(await page.locator("#directory").getAttribute("data-ids"), expectedIds);
      const beforeRefresh = await page.evaluate(
        () => window.performanceRound12Subagents.calls().length,
      );
      await page.getByRole("button", { name: "Refresh" }).click();
      await page.waitForFunction(
        () => document.querySelector("#refresh-complete")?.textContent === "1",
      );
      assert.equal(await page.locator("#directory").getAttribute("data-count"), "140");
      assert.equal(await page.locator("#directory").getAttribute("data-next-cursor"), "140");
      assert.equal(await page.locator("#directory").getAttribute("data-ids"), expectedIds);
      const refreshCalls = await page.evaluate(
        (start) => window.performanceRound12Subagents.calls().slice(start),
        beforeRefresh,
      );
      assert.deepEqual(refreshCalls, [
        { endedLimit: 100 },
        { endedLimit: 20, endedCursor: "100" },
        { endedLimit: 20, endedCursor: "120" },
      ]);
      assert.deepEqual(pageErrors, []);
      assert.ok(
        requests.every((url) => url.startsWith(baseUrl)),
        `browser requested non-loopback resources: ${requests.filter((url) => !url.startsWith(baseUrl))}`,
      );
      assert.deepEqual(
        { firstPageFollowups, secondPageFollowups },
        {
          firstPageFollowups: 0,
          secondPageFollowups: 0,
        },
      );
    } finally {
      try {
        await context?.close();
      } finally {
        try {
          await server?.close();
        } finally {
          await rm(profileDirectory, { recursive: true, force: true });
        }
      }
    }
  },
);
