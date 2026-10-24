import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { createServer as createViteServer } from "vite";
import tailwindcss from "@tailwindcss/vite";

// --serve 保留人工验收；默认运行真实 hook/panel 的持久 Playwright E2E 门禁。
const root = resolve(import.meta.dirname, "../..");
const { outputFiles } = await build({
  entryPoints: [resolve(import.meta.dirname, "fixtures/coding-plan-quota.jsx")],
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  alias: { "@": resolve(root, "packages/ui/src") },
  loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl" },
  define: { "process.env.NODE_ENV": '"production"' },
});
const cacheDir = await mkdtemp(join(tmpdir(), "zcodium-quota-css-"));
let vite;
const server = createServer(async (request, response) => {
  if (request.url === "/fixture.js") {
    response.setHeader("Content-Type", "text/javascript");
    response.end(outputFiles[0].contents);
  } else if (
    request.url?.startsWith("/@") ||
    request.url?.startsWith("/packages/") ||
    request.url?.startsWith("/node_modules/")
  ) {
    vite.middlewares(request, response, () => {
      response.statusCode = 404;
      response.end("not found");
    });
  } else {
    response.setHeader("Content-Type", "text/html");
    response.end(
      (await vite.transformIndexHtml(
        "/",
        '<!doctype html><meta name="viewport" content="width=device-width"><style>html,body,#root { height:auto; overflow:visible; }</style><div id="root"></div><script type="module">import "/packages/ui/src/styles.css";</script>',
      )) + '<script type="module" src="/fixture.js"></script>',
    );
  }
});
vite = await createViteServer({
  configFile: false,
  root,
  cacheDir,
  appType: "custom",
  plugins: [tailwindcss()],
  server: { middlewareMode: true, hmr: { server, host: "127.0.0.1" }, watch: { ignored: ["**"] } },
  optimizeDeps: { noDiscovery: true },
});
server.listen(Number(process.env.ZCODE_TEST_PORT || 0), "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const closeFixture = async () => {
  await vite.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await rm(cacheDir, { recursive: true, force: true });
};
if (process.argv.includes("--serve")) {
  console.log(`Coding Plan quota fixture ${origin}/?locale=zh-CN`);
  console.log(
    "Query options: locale=en-US|zh-CN, theme=light|dark, loading, error, empty, zero, missing, unsupported, none",
  );
} else {
  let browser;
  try {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({
      headless: true,
      channel:
        !process.env.ZCODE_TEST_CHROMIUM_EXECUTABLE && process.platform === "win32"
          ? "msedge"
          : undefined,
      executablePath: process.env.ZCODE_TEST_CHROMIUM_EXECUTABLE || undefined,
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors = [],
      external = [],
      failedRequests = [],
      failedResponses = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("requestfailed", (request) =>
      failedRequests.push({ url: request.url(), error: request.failure()?.errorText }),
    );
    page.on("response", (response) => {
      if (response.status() >= 400)
        failedResponses.push({ url: response.url(), status: response.status() });
    });
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin || ["data:", "blob:"].includes(url.protocol))
        return route.continue();
      external.push(url.href);
      return route.abort("blockedbyclient");
    });
    const control = (name) => page.getByRole("button", { name, exact: true });
    const settle = async () => {
      await page.evaluate(async () => {
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
      });
    };
    const metric = (key) => page.evaluate((key) => window.codingPlanQuotaFixture[key], key);
    const waitHeld = () =>
      page.waitForFunction(() => window.codingPlanQuotaFixture.pending.length > 0);
    const waitSettled = (expected) =>
      page.waitForFunction(
        (expected) => window.codingPlanQuotaFixture.settled === expected,
        expected,
      );
    for (const locale of ["en-US", "zh-CN"])
      for (const theme of ["light", "dark"])
        for (const width of [390, 1280]) {
          await page.setViewportSize({ width, height: 1000 });
          const zh = locale === "zh-CN";
          const region = page.getByRole("region", {
            name: zh ? "个人 Coding Plan 额度" : "Personal Coding Plan quota",
            exact: true,
          });
          const refresh = () =>
            region.getByRole("button", { name: zh ? "刷新" : "Refresh", exact: true });
          const value = (number) =>
            region.getByText(zh ? `剩余 ${number}` : `${number} remaining`, { exact: true });
          const empty = () =>
            region.getByText(zh ? "暂无可用额度信息。" : "No quota information available.", {
              exact: true,
            });
          await page.goto(`${origin}/?locale=${locale}&theme=${theme}&loading`);
          await waitHeld();
          await region.getByRole("status").waitFor();
          assert.equal(await value(30).count(), 0, "initial loading must not invent quota");
          assert.equal(await refresh().isDisabled(), true);
          await control("Release old requests").click();
          await value(30).waitFor();
          await region.getByRole("status").waitFor({ state: "hidden" });
          assert.equal(await metric("requests").then((items) => items.length), 1);
          await settle();
          assert.equal(
            await metric("requests").then((items) => items.length),
            1,
            "unrelated renders do not poll",
          );
          assert.equal(
            await region.evaluate((element) => element.scrollWidth > element.clientWidth),
            false,
            `${locale}/${theme}/${width} no horizontal overflow`,
          );

          await control("Next refresh fails").click();
          await refresh().click();
          await region.getByRole("alert").waitFor();
          await value(30).waitFor();
          await refresh().click();
          await region.getByRole("alert").waitFor({ state: "hidden" });
          await value(30).waitFor();

          await control("Zero on next request").click();
          await refresh().click();
          await value(0).waitFor();
          assert.equal(await empty().count(), 0, "real zero differs from missing data");
          assert.equal(await region.getByRole("progressbar").getAttribute("aria-valuenow"), "0");
          await control("Empty on next request").click();
          await refresh().click();
          await empty().waitFor();
          assert.equal(await value(0).count(), 0);
          await control("Data on next request").click();
          await refresh().click();
          await value(30).waitFor();

          // 同一 Host 更换 Key 时，旧 30 必须在新请求仍 held 的时候就消失。
          await control("Zero on next request").click();
          await control("Hold next request").click();
          await control("Change key/provider").click();
          await waitHeld();
          await region.getByRole("status").waitFor();
          assert.equal(
            await value(30).count(),
            0,
            "key change clears old snapshot before response",
          );
          await control("Release old requests").click();
          await value(0).waitFor();

          // held 的旧成功跨 Key 到达，不得覆盖当前零余量。
          await control("Data on next request").click();
          await control("Hold next request").click();
          await refresh().click();
          await waitHeld();
          await control("Zero on next request").click();
          await control("Change key/provider").click();
          await value(0).waitFor();
          await refresh().waitFor({ state: "visible" });
          await page.waitForFunction(() => !document.querySelector("section button")?.disabled);
          let expected = (await metric("settled")) + 1;
          await control("Release old requests").click();
          await waitSettled(expected);
          await settle();
          await value(0).waitFor();
          assert.equal(await value(30).count(), 0, "late old-key success discarded");

          // held 的旧失败跨 Host 到达，不得给新 Host 加 error。
          await control("Data on next request").click();
          await control("Next refresh fails").click();
          await control("Hold next request").click();
          await refresh().click();
          await waitHeld();
          await control("Hold next request").click();
          await control("Switch Host").click();
          await page.getByRole("heading", { name: /fixture — Host B$/ }).waitFor();
          await region.getByRole("status").waitFor();
          assert.equal(await value(0).count(), 0, "Host change clears previous snapshot");
          expected = (await metric("settled")) + 2;
          await control("Release old requests").click();
          await waitSettled(expected);
          await value(60).waitFor();
          await settle();
          assert.equal(
            await region.getByRole("alert").count(),
            0,
            "late old-Host failure discarded",
          );

          // 离页前 hold 旧成功；重进先拿零，再释放旧响应，不能回写新挂载实例。
          await control("Hold next request").click();
          await refresh().click();
          await waitHeld();
          await control("Leave usage page").click();
          await region.waitFor({ state: "detached" });
          assert.equal(
            await metric("subscriptions"),
            0,
            "unmount releases context event subscription",
          );
          await control("Zero on next request").click();
          await control("Open usage page").click();
          await value(0).waitFor();
          expected = (await metric("settled")) + 1;
          await control("Release old requests").click();
          await waitSettled(expected);
          await settle();
          await value(0).waitFor();
          assert.equal(await value(60).count(), 0, "late unmounted success discarded");

          // 最后连接移除时即使 held 失败回来，也维持引导而非旧数据或 error。
          await control("Next refresh fails").click();
          await control("Hold next request").click();
          await refresh().click();
          await waitHeld();
          await control("Remove connection").click();
          await region
            .getByText(
              zh
                ? "请在模型设置中配置个人 Coding Plan 专用 API Key。"
                : "Configure a personal Coding Plan API key in model settings.",
              { exact: true },
            )
            .waitFor();
          expected = (await metric("settled")) + 1;
          await control("Release old requests").click();
          await waitSettled(expected);
          await settle();
          assert.equal(await region.getByRole("alert").count(), 0);
          assert.equal(await value(0).count(), 0);
          const requests = await metric("requests");
          for (const request of requests) {
            assert.deepEqual(Object.keys(request).sort(), ["contextId", "host"]);
            assert.ok(request.contextId.includes("opaque"));
          }
          assert.deepEqual(await metric("pending"), []);
          assert.equal(await metric("subscriptions"), 1);
        }
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    assert.deepEqual(failedRequests, []);
    assert.deepEqual(failedResponses, []);
    console.log(
      "PASS quota E2E: loading, failed-refresh retention, zero/empty, key/Host fences, late success/failure, page exit, subscription cleanup; EN/ZH light/dark narrow/wide; no external requests or UI errors.",
    );
  } finally {
    await browser?.close();
    await closeFixture();
  }
}
