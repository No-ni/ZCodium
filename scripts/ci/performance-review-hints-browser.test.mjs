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
  "hint wrappers preserve React ref lifecycles and button interactions",
  { timeout: 120_000 },
  async (t) => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const temporaryRoot = await mkdtemp(join(tmpdir(), "zcodium-review-hints-"));
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
            "radix-ui",
            "class-variance-authority",
            "clsx",
            "tailwind-merge",
          ],
        },
        server: { host: "127.0.0.1", port: 0, hmr: false },
        logLevel: "error",
      });
      await new Promise((done, reject) => {
        server.httpServer.once("error", reject);
        server.httpServer.listen(0, "127.0.0.1", done);
      });
      const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
      context = await chromium.launchPersistentContext(join(temporaryRoot, "profile"), {
        channel: process.platform === "win32" ? "msedge" : "chrome",
        headless: true,
      });
      const external = [];
      const errors = [];
      await context.route("**/*", async (route) => {
        if (new URL(route.request().url()).origin === new URL(baseUrl).origin)
          await route.continue();
        else {
          external.push(route.request().url());
          await route.abort();
        }
      });
      const page = context.pages()[0];
      page.on("pageerror", (error) => errors.push(error.message));
      const open = async (config) => {
        await page.goto(`${baseUrl}packages/ui/test/performance-review-hints.html`);
        await page.waitForFunction(() => Boolean(window.performanceReviewHints));
        await page.evaluate((next) => window.performanceReviewHints.render(next), config);
      };
      const render = (config) =>
        page.evaluate((next) => window.performanceReviewHints.render(next), config);
      const snapshot = () => page.evaluate(() => window.performanceReviewHints.snapshot());
      const refEvents = (state) => state.events.filter((event) => /^(child|trigger)-/.test(event));
      const failures = [];
      let scenarios = 0;
      for (const mode of ["scoped", "fallback", "direct"]) {
        for (const strict of [false, true]) {
          for (const kind of ["cleanup", "legacy", "object"]) {
            for (const triggerKind of mode === "direct"
              ? ["cleanup", "legacy", "object"]
              : ["legacy"]) {
              scenarios++;
              await open({ mode, strict, kind, triggerKind });
              const mounted = await snapshot();
              await render({ revision: 1 });
              const rerendered = await snapshot();
              await render({ generation: 1 });
              const replaced = await snapshot();
              await render({ mounted: false });
              const unmounted = await snapshot();
              try {
                if (mode === "scoped")
                  assert.deepEqual(
                    refEvents(rerendered),
                    refEvents(mounted),
                    "shared scope refs must not reattach on rerender",
                  );
                assert.equal(mounted.connected, true);
                const keys = mode === "direct" ? ["child-1", "trigger-1"] : ["child-1"];
                assert.deepEqual(
                  replaced.live.sort(),
                  keys,
                  "old resources must release before attaching replacements",
                );
                assert.deepEqual(unmounted.live, [], "unmount must release all resources");
                for (const [owner, refKind] of [
                  ["child", kind],
                  ...(mode === "direct" ? [["trigger", triggerKind]] : []),
                ]) {
                  for (const generation of [0, 1]) {
                    const prefix = `${owner}-${generation}:`;
                    const calls = unmounted.events.filter((event) => event.startsWith(prefix));
                    const count = (phase) =>
                      calls.filter((event) => event === prefix + phase).length;
                    assert.ok(count("attach") >= 1);
                    assert.equal(
                      count(refKind === "cleanup" ? "cleanup" : "null"),
                      count("attach"),
                    );
                    assert.equal(count(refKind === "cleanup" ? "null" : "cleanup"), 0);
                  }
                }
              } catch (error) {
                failures.push({
                  mode,
                  strict,
                  kind,
                  triggerKind,
                  error: error.message.split("\n")[0],
                });
              }
            }
          }
        }
      }
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 844 });
        await open({ mode: "scoped", kind: "legacy" });
        const action = page.locator("#hint-button");
        const hint = page.getByRole("tooltip");
        const initialRefs = refEvents(await snapshot());
        await action.hover();
        await hint.waitFor({ state: "visible" });
        assert.equal(await hint.count(), 1);
        assert.equal((await hint.textContent()).trim(), "Action hint");
        const hintId = await hint.getAttribute("id");
        assert.ok((await action.getAttribute("aria-describedby")).split(/\s+/).includes(hintId));
        await action.click();
        await hint.waitFor({ state: "detached" });
        assert.equal(await action.getAttribute("aria-describedby"), "existing-description");
        await page.locator("#before").click();
        await page.keyboard.press("Tab");
        await hint.waitFor({ state: "visible" });
        assert.equal(await action.evaluate((node) => node === document.activeElement), true);
        await page.keyboard.press("Escape");
        await hint.waitFor({ state: "detached" });
        await page.keyboard.press("Enter");
        await page.keyboard.press("Tab");
        await render({ prevent: true });
        await action.hover();
        assert.equal(await hint.count(), 0);
        await page.locator("#before").click();
        await page.keyboard.press("Tab");
        assert.equal(await hint.count(), 0);
        const interacted = await snapshot();
        assert.deepEqual(refEvents(interacted), initialRefs);
        for (const event of [
          "pointerenter",
          "pointerleave",
          "pointerdown",
          "focus",
          "blur",
          "keydown:Escape",
          "keydown:Enter",
          "click",
        ]) {
          assert.ok(interacted.events.includes(event), event);
        }
        assert.equal(interacted.events.filter((event) => event === "click").length, 2);
        await render({ mounted: false });
        assert.deepEqual((await snapshot()).live, []);
        assert.equal(await page.locator("[data-code-block-shared-hint-anchor]").count(), 0);
      }
      t.diagnostic(JSON.stringify({ scenarios, failures, external, errors }));
      assert.deepEqual(external, []);
      assert.deepEqual(errors, []);
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
          assert.ok(basename(cleanupRoot).startsWith("zcodium-review-hints-"));
          await rm(cleanupRoot, { recursive: true, force: true });
        }
      }
    }
  },
);
