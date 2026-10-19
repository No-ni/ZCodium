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
  "plugin disposition keeps equal snapshots stable and real changes immediate",
  { timeout: 120_000 },
  async (t) => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const temporaryRoot = await mkdtemp(join(tmpdir(), "zcodium-plugin-disposition-"));
    let server;
    let context;
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
            "zustand/react/shallow",
          ],
          entries: [resolve(root, "packages/ui/test/performance-plugin-disposition.html")],
        },
        server: { host: "127.0.0.1", port: 0 },
        logLevel: "error",
      });
      await new Promise((ready, reject) => {
        server.httpServer.once("error", reject);
        server.httpServer.listen(0, "127.0.0.1", ready);
      });
      const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
      context = await chromium.launchPersistentContext(join(temporaryRoot, "profile"), {
        channel: process.platform === "win32" ? "msedge" : "chrome",
        headless: true,
      });
      const external = [];
      await context.route("**/*", async (route) => {
        if (new URL(route.request().url()).origin === origin) await route.continue();
        else {
          external.push(route.request().url());
          await route.abort();
        }
      });
      const page = context.pages()[0];
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const measurements = [];
      for (const viewport of [
        { width: 1280, height: 900 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(viewport);
        await page.goto(`${origin}/packages/ui/test/performance-plugin-disposition.html?reference`);
        await page.waitForFunction(() => Boolean(window.pluginDisposition));
        const baselineBefore = await page.evaluate(() => window.pluginDisposition.counts());
        await page.evaluate(() => window.pluginDisposition.stream(30));
        const baselineAfter = await page.evaluate(() => window.pluginDisposition.counts());
        const baselineAdditionalRenders = baselineAfter.reduce(
          (sum, value, index) => sum + value - baselineBefore[index],
          0,
        );
        assert.equal(baselineAdditionalRenders, 360);
        await page.goto(`${origin}/packages/ui/test/performance-plugin-disposition.html`);
        await page.waitForFunction(() => Boolean(window.pluginDisposition));
        const counts = () => page.evaluate(() => window.pluginDisposition.counts());
        const before = await counts();
        await page.evaluate(() => window.pluginDisposition.stream(30));
        const after = await counts();
        measurements.push({
          viewport,
          baselineAdditionalRenders,
          additionalRenders: after.reduce((sum, value, index) => sum + value - before[index], 0),
        });
        const output = page.locator("#card-0 output");
        const read = async () => JSON.parse(await output.textContent());
        for (const patch of [
          { key: "changed-logical-key" },
          { superseded: true },
          { autoExpand: false },
          { forcedInline: true },
        ]) {
          await page.evaluate((value) => window.pluginDisposition.patch(value), patch);
          for (const [key, value] of Object.entries(patch))
            assert.equal((await read())[key], value);
        }
        await page.locator("#card-0 button").click();
        assert.equal(await page.locator("#card-0 button").textContent(), "Unpin");
        await page.evaluate(() => window.pluginDisposition.age());
        assert.equal((await read()).autoExpand, false);
        await page.evaluate(() => window.pluginDisposition.remove());
        assert.equal(await output.textContent(), "absent");
        await page.evaluate(() => window.pluginDisposition.restore());
        assert.equal((await read()).autoExpand, true);
        await page.evaluate(() => window.pluginDisposition.session("session-b"));
        assert.equal(await output.textContent(), "absent");
        await page.evaluate(() => window.pluginDisposition.restore());
        assert.equal((await read()).superseded, false);
        await page.evaluate(() => window.pluginDisposition.visible(false));
        const unmounted = await counts();
        await page.evaluate(() => window.pluginDisposition.stream(5));
        assert.deepEqual(await counts(), unmounted);
        await page.evaluate(() => window.pluginDisposition.visible(true));
        assert.equal((await read()).autoExpand, true);

        // 直接挂载生产发布 hook，覆盖 effect 生命周期；订阅性能对照继续独立计数。
        const first = { id: "first", session: "lifecycle-a", tag: "first" };
        const render = (inputs) =>
          page.evaluate((value) => window.pluginDisposition.lifecycle.render(value), inputs);
        const snapshot = (session) =>
          page.evaluate((value) => window.pluginDisposition.lifecycle.snapshot(value), session);
        await render([first]);
        const firstKey = (await snapshot(first.session)).key;
        assert.equal(
          await page.locator('[data-lifecycle-session="lifecycle-a"]').textContent(),
          firstKey,
        );
        const strictEvents = await page.evaluate(() =>
          window.pluginDisposition.lifecycle.events("lifecycle-a"),
        );
        assert.ok(strictEvents.includes(null), "StrictMode must exercise cleanup and republish");
        assert.equal(strictEvents.at(-1), firstKey);
        await page.evaluate(() => window.pluginDisposition.lifecycle.clearEvents());
        await render([{ ...first, revision: 1 }]);
        const updateEvents = await page.evaluate(() =>
          window.pluginDisposition.lifecycle.events("lifecycle-a"),
        );
        assert.deepEqual(
          updateEvents,
          [firstKey],
          "body updates must not temporarily remove the disposition",
        );
        await render([{ ...first, revision: 1, visible: false }]);
        assert.equal(await page.locator('[data-lifecycle-session="lifecycle-a"]').count(), 0);
        assert.equal((await snapshot(first.session)).key, firstKey);
        const moved = { ...first, session: "lifecycle-b" };
        await render([moved]);
        assert.equal(await snapshot(first.session), null);
        assert.equal((await snapshot(moved.session)).key, firstKey);
        await render([moved, { ...moved, id: "second", tag: "second" }]);
        assert.notEqual((await snapshot(moved.session)).key, firstKey);
        await render([moved]);
        assert.equal((await snapshot(moved.session)).key, firstKey);
        await render([]);
        assert.equal(await snapshot(moved.session), null);
        await render([moved]);
        assert.equal((await snapshot(moved.session)).key, firstKey);
        await page.evaluate(() => window.pluginDisposition.lifecycle.unmount());
        assert.equal(await snapshot(moved.session), null);
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      t.diagnostic(JSON.stringify(measurements));
      assert.ok(
        measurements.every((measurement) => measurement.additionalRenders === 0),
        "equal dispositions must not trigger card renders",
      );
    } finally {
      await context?.close();
      await server?.close();
      const resolved = resolve(temporaryRoot);
      assert.equal(dirname(resolved), resolve(tmpdir()));
      assert.ok(basename(resolved).startsWith("zcodium-plugin-disposition-"));
      await rm(resolved, { recursive: true, force: true });
    }
  },
);
