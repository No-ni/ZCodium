import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright-core";
import { createServer } from "vite";

test(
  "background output cancels obsolete reads across shared handshake boundaries",
  { timeout: 120_000 },
  async (t) => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const temporaryRoot = await mkdtemp(join(tmpdir(), "zcodium-round14-output-"));
    let server;
    let context;
    try {
      server = await createServer({
        configFile: false,
        root,
        cacheDir: join(temporaryRoot, "vite-cache"),
        plugins: [react()],
        resolve: {
          alias: [
            {
              find: "@/hooks/useZCodeAgentService.js",
              replacement: resolve(root, "packages/ui/test/performance-round14-output-service.ts"),
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
          entries: [resolve(root, "packages/ui/test/performance-round14-output.html")],
        },
        server: { host: "127.0.0.1", port: 0 },
        logLevel: "error",
      });
      // Vite 的端口默认处理会把 0 转成 5173，直接给底层 server 绑定随机端口。
      await new Promise((resolveListen, reject) => {
        server.httpServer.once("error", reject);
        server.httpServer.listen(0, "127.0.0.1", resolveListen);
      });
      const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
      context = await chromium.launchPersistentContext(join(temporaryRoot, "profile"), {
        channel: process.platform === "win32" ? "msedge" : "chrome",
        headless: true,
      });
      const external = [];
      await context.route("**/*", async (route) => {
        if (new URL(route.request().url()).origin === new URL(baseUrl).origin)
          await route.continue();
        else {
          external.push(route.request().url());
          await route.abort();
        }
      });
      const page = context.pages()[0] ?? (await context.newPage());
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const snapshot = () => page.evaluate(() => window.performanceRound14Output.snapshot());
      const settle = () =>
        page.evaluate(
          () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
        );
      const open = async (mode) => {
        await page.goto(`${baseUrl}packages/ui/test/performance-round14-output.html?mode=${mode}`, {
          waitUntil: "domcontentloaded",
        });
        await page.waitForFunction(
          () => window.performanceRound14Output?.snapshot().helloCalls === 1,
        );
      };
      const hello = async () => {
        await page.evaluate(() => window.performanceRound14Output.resolveHello());
        await page.waitForFunction(
          () => window.performanceRound14Output.snapshot().clientHellos.length === 1,
        );
      };
      const initialize = async () => {
        await page.evaluate(() => window.performanceRound14Output.resolveInit());
        await settle();
      };
      const resolveOutput = async (status = "completed", text) => {
        await page.evaluate(
          ({ status, text }) => window.performanceRound14Output.resolveOutput(status, text),
          { status, text },
        );
        await settle();
      };
      const failures = [];
      let scenarios = 0;
      for (const mode of ["desktop", "mobile"]) {
        for (const stage of ["hello", "initialize"]) {
          for (const action of [
            "Hide output",
            "Unmount output",
            "Switch target",
            "Refresh output",
          ]) {
            await open(mode);
            if (stage === "initialize") await hello();
            await page.getByRole("button", { name: action, exact: true }).click();
            await settle();
            if (stage === "hello") await hello();
            await initialize();
            // 清掉已发出的合成 RPC，观察是否还追加了另一份查询。
            for (let index = 0; index < 3 && (await snapshot()).pending; index++)
              await resolveOutput();
            const state = await snapshot();
            const expected =
              action === "Switch target"
                ? ["work-b"]
                : action === "Refresh output"
                  ? ["work-a"]
                  : [];
            if (
              JSON.stringify(state.calls.map((call) => call.workId)) !== JSON.stringify(expected)
            ) {
              failures.push({
                mode,
                stage,
                action,
                expected,
                actual: state.calls.map((call) => call.workId),
              });
            }
            assert.equal(state.helloCalls, 1);
            assert.equal(state.clientHellos.length, 1);
            assert.equal(state.clientHellos[0].clientKind, mode === "desktop" ? "desktop" : "web");
            for (const call of state.calls)
              assert.deepEqual(call, {
                workspacePath: "C:/synthetic/workspace",
                workspaceIdentity: "synthetic-identity",
                remoteSessionId: "synthetic-attachment",
                sessionId: "synthetic-session",
                workId: call.workId,
              });
            if (action === "Hide output" || action === "Unmount output") {
              await page.getByRole("button", { name: "Open output", exact: true }).click();
              await page.waitForFunction(
                () => window.performanceRound14Output.snapshot().pending === 1,
              );
              await resolveOutput("completed", "reopened");
              assert.equal(await page.locator("#output").textContent(), "reopened");
              assert.equal((await snapshot()).helloCalls, 1);
            }
            scenarios++;
          }
        }
        await open(mode);
        await hello();
        await initialize();
        await page.clock.install();
        await resolveOutput("running", "first");
        await page.getByRole("button", { name: "Pause display", exact: true }).click();
        await page.clock.runFor(1100);
        await page.waitForFunction(() => window.performanceRound14Output.snapshot().pending === 1);
        await resolveOutput("completed", "second");
        assert.equal(await page.locator("#output").textContent(), "first");
        await page.getByRole("button", { name: "Resume display", exact: true }).click();
        await page.waitForFunction(() => window.performanceRound14Output.snapshot().pending === 1);
        await resolveOutput("completed", "third");
        assert.equal(await page.locator("#output").textContent(), "third");
        const completedCount = (await snapshot()).calls.length;
        await page.clock.runFor(2100);
        assert.equal((await snapshot()).calls.length, completedCount);
        await page.getByRole("button", { name: "Refresh output", exact: true }).click();
        await page.waitForFunction(() => window.performanceRound14Output.snapshot().pending === 1);
        await page.getByRole("button", { name: "Hide output", exact: true }).click();
        await resolveOutput("running", "late result");
        await page.clock.runFor(2100);
        assert.equal((await snapshot()).calls.length, completedCount + 1);
        assert.equal(await page.locator("#output").textContent(), "third");
      }
      t.diagnostic(
        `${scenarios} handshake cancellation scenarios; ${failures.length} obsolete-query violations`,
      );
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      assert.deepEqual(failures, []);
    } finally {
      try {
        await context?.close();
      } finally {
        try {
          await server?.close();
        } finally {
          const cleanupRoot = resolve(temporaryRoot);
          assert.equal(dirname(cleanupRoot), resolve(tmpdir()));
          assert.ok(basename(cleanupRoot).startsWith("zcodium-round14-output-"));
          await rm(cleanupRoot, { recursive: true, force: true });
        }
      }
    }
  },
);
