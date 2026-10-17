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
  "settings consumers share native subscriptions by setting service and platform",
  { timeout: 90_000 },
  async (t) => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const profileDirectory = await mkdtemp(
      join(tmpdir(), "zcodium-performance-round13-settings-edge-"),
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
          entries: [resolve(root, "packages/ui/test/performance-round13-settings.html")],
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
      const fixtureUrl = `${baseUrl}packages/ui/test/performance-round13-settings.html`;
      const fixtureResponse = await fetch(fixtureUrl, { signal: AbortSignal.timeout(10_000) });
      t.diagnostic(`fixture HTTP ${fixtureResponse.status}`);
      assert.equal(fixtureResponse.status, 200);
      await page.goto(fixtureUrl, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => Boolean(window.performanceRound13Settings));

      const mount = async (name, serviceId, platformId, strictMode = false) =>
        page.evaluate(
          ({ name, serviceId, platformId, strictMode }) =>
            window.performanceRound13Settings.mount(name, serviceId, platformId, strictMode),
          { name, serviceId, platformId, strictMode },
        );
      const unmount = async (name) =>
        page.evaluate((value) => window.performanceRound13Settings.unmount(value), name);
      const snapshot = async () =>
        page.evaluate(() => window.performanceRound13Settings.snapshot());
      const fire = async (platformId) =>
        page.evaluate((value) => window.performanceRound13Settings.fire(value), platformId);
      const setSynchronousRegistrationCallback = async (platformId, enabled) =>
        page.evaluate(
          ({ platformId, enabled }) =>
            window.performanceRound13Settings.setSynchronousRegistrationCallback(
              platformId,
              enabled,
            ),
          { platformId, enabled },
        );

      await mount("a", "service-1", "platform-1");
      await mount("b", "service-1", "platform-1");
      await mount("c", "service-1", "platform-1");
      let state = await snapshot();
      assert.equal(state.platforms["platform-1"].registrations, 1);
      assert.equal(state.platforms["platform-1"].active, 1);
      assert.equal(state.services["service-1"].calls, 3);

      await fire("platform-1");
      await page.waitForFunction(
        () => window.performanceRound13Settings.snapshot().services["service-1"].calls === 4,
      );
      state = await snapshot();
      assert.equal(state.platforms["platform-1"].callbackCalls, 1);

      await unmount("a");
      await fire("platform-1");
      await page.waitForFunction(
        () => window.performanceRound13Settings.snapshot().services["service-1"].calls === 5,
      );
      assert.equal((await snapshot()).platforms["platform-1"].active, 1);

      await setSynchronousRegistrationCallback("platform-2", true);
      await mount("d", "service-1", "platform-2");
      await mount("e", "service-2", "platform-1");
      await mount("f", "service-2", "platform-1");
      state = await snapshot();
      assert.deepEqual(
        {
          platform1: state.platforms["platform-1"].active,
          platform2: state.platforms["platform-2"].active,
          service2Calls: state.services["service-2"].calls,
        },
        { platform1: 2, platform2: 1, service2Calls: 2 },
      );

      await unmount("b");
      await unmount("c");
      state = await snapshot();
      assert.equal(state.platforms["platform-1"].active, 1);
      assert.equal(state.platforms["platform-2"].active, 1);

      await unmount("d");
      state = await snapshot();
      assert.equal(state.platforms["platform-2"].active, 0);
      assert.equal(state.platforms["platform-1"].active, 1);

      await fire("platform-1");
      await page.waitForFunction(
        () => window.performanceRound13Settings.snapshot().services["service-2"].calls === 3,
      );
      assert.equal((await snapshot()).services["service-1"].calls, 6);
      await unmount("e");
      await unmount("f");
      assert.equal((await snapshot()).platforms["platform-1"].active, 0);

      await mount("g", "service-1", "platform-1");
      state = await snapshot();
      assert.equal(state.platforms["platform-1"].active, 1);
      assert.equal(state.platforms["platform-1"].registrations, 3);
      await unmount("g");
      assert.equal((await snapshot()).platforms["platform-1"].active, 0);

      await mount("h", "service-1", "platform-1", true);
      state = await snapshot();
      assert.equal(state.platforms["platform-1"].active, 1);
      assert.equal(state.platforms["platform-1"].registrations, 5);
      await unmount("h");
      assert.equal((await snapshot()).platforms["platform-1"].active, 0);

      assert.deepEqual(pageErrors, []);
      assert.ok(
        requests.every((url) => url.startsWith(baseUrl)),
        `browser requested non-loopback resources: ${requests.filter((url) => !url.startsWith(baseUrl))}`,
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
