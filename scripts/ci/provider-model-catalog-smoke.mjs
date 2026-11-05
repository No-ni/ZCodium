import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertProjectPath,
  createProjectTestSandbox,
  projectRoot,
} from "./project-test-sandbox.mjs";

const sandbox = await createProjectTestSandbox("provider-model-catalog-browser");
// esbuild/Playwright 装载与子进程启动前先绑定项目环境，不使用真实用户配置或系统 TEMP。
const previous = { ...process.env };
for (const key of Object.keys(process.env)) if (!(key in sandbox.env)) delete process.env[key];
Object.assign(process.env, sandbox.env);
const browserOption = process.argv.indexOf("--chromium");
if (browserOption !== -1) {
  assert.ok(process.argv[browserOption + 1], "--chromium requires an existing executable");
  process.env.ZCODE_TEST_CHROMIUM_EXECUTABLE = process.argv[browserOption + 1];
}
const [{ build, stop }, { launchProjectTestPage }] = await Promise.all([
  import("esbuild"),
  import("./project-test-browser.mjs"),
]);
let browser;
let server;
let caseName = "initialization";
const errors = [];
const completed = [];
try {
  const { outputFiles } = await build({
    entryPoints: [join(import.meta.dirname, "fixtures/provider-model-catalog.jsx")],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    jsx: "automatic",
    alias: { "@": join(projectRoot, "packages/ui/src") },
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".css": "empty", ".png": "dataurl", ".svg": "dataurl" },
  });
  stop();
  server = createServer((request, response) => {
    if (request.url?.split("?")[0] === "/fixture.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(outputFiles[0].contents);
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end(
        '<!doctype html><div id="root"></div><script type="module" src="/fixture.js"></script>',
      );
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = "http://127.0.0.1:" + server.address().port;
  browser = await launchProjectTestPage(sandbox);
  const { page } = browser;
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    errors.push("Unexpected external fixture request");
    return route.abort();
  });
  for (const locale of ["en-US", "zh-CN"]) {
    for (const width of [390, 1280]) {
      caseName = locale + "-" + width;
      await page.setViewportSize({ width, height: 850 });
      await page.goto(origin + "/?locale=" + locale);
      await page.getByTestId("model-provider-fetch-models-button").click();
      const dialog = page.getByRole("dialog");
      const confirm = () =>
        dialog.getByRole("button", { name: locale === "zh-CN" ? /添加所选/ : /Add selected/ });
      const checkbox = (name) => dialog.getByRole("checkbox", { name, exact: true });
      await checkbox("catalog-c").click();
      assert.equal(await checkbox("catalog-c").isChecked(), false);
      await confirm().click();
      await dialog.getByRole("alert").waitFor();
      assert.equal(
        await dialog.getByRole("alert").textContent(),
        locale === "zh-CN" ? "已添加 1 个模型，1 个失败。" : "Added 1 models, 1 failed.",
      );
      assert.equal(await checkbox("catalog-a").isDisabled(), true);
      assert.equal(await checkbox("catalog-b").isChecked(), true);
      await page.screenshot({
        path: await assertProjectPath(join(sandbox.logs, caseName + "-partial.png")),
      });
      assert.equal(
        await checkbox("catalog-c").isChecked(),
        false,
        "PCAT01: 部分成功不能重新勾选用户排除的模型",
      );
      assert.equal(
        await confirm().textContent(),
        locale === "zh-CN" ? "添加所选（1）" : "Add selected (1)",
      );
      await confirm().click();
      await dialog.waitFor({ state: "hidden" });
      assert.deepEqual(
        await page.evaluate(() => window.catalogFixture.writes.map((model) => model.modelId)),
        ["catalog-a", "catalog-b", "catalog-b"],
      );
      assert.deepEqual(await page.evaluate(() => window.catalogFixture.writes[0].personalConfig), {
        properties: { contextWindow: 16384 },
        optionSpecs: { maxOutputTokens: { max: 4096 } },
      });
      completed.push(caseName + "-PCAT01");

      await page.getByTestId("model-provider-fetch-models-button").click();
      assert.equal(await checkbox("catalog-a").isDisabled(), true);
      assert.equal(await checkbox("catalog-b").isDisabled(), true);
      assert.equal(await checkbox("catalog-c").isChecked(), true, "PCAT02: 重新获取恢复默认勾选");
      await checkbox("catalog-c").click();
      await dialog
        .getByRole("button", { name: locale === "zh-CN" ? "取消" : "Cancel", exact: true })
        .click();
      await page.getByTestId("model-provider-fetch-models-button").click();
      assert.equal(
        await checkbox("catalog-c").isChecked(),
        true,
        "PCAT02: 取消后再次打开恢复默认勾选",
      );
      await page.screenshot({
        path: await assertProjectPath(join(sandbox.logs, caseName + "-reopen.png")),
      });
      completed.push(caseName + "-PCAT02");

      await page.goto(origin + "/?locale=" + locale + "&mode=fetch-error");
      await page.getByTestId("model-provider-fetch-models-button").click();
      await page.getByRole("alert").waitFor();
      assert.equal(
        await page.getByRole("alert").textContent(),
        locale === "zh-CN"
          ? "获取模型列表失败：接口请求失败"
          : "Failed to fetch models: The endpoint request failed",
      );
      assert.equal(
        (await page.locator("body").textContent()).includes("SYNTHETIC_CATALOG_PRIVATE_MARKER"),
        false,
      );
      await page.screenshot({
        path: await assertProjectPath(join(sandbox.logs, caseName + "-failure.png")),
      });
      completed.push(caseName + "-PCAT04");
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ completed: completed.length, cases: completed, artifacts: sandbox.root }),
  );
} catch (error) {
  if (browser)
    await browser.page.screenshot({
      path: await assertProjectPath(join(sandbox.logs, caseName + "-failed.png")),
    });
  throw error;
} finally {
  await writeFile(
    join(sandbox.root, "results.json"),
    JSON.stringify({ completed, errors, caseName }, null, 2),
    { flag: "wx" },
  );
  await browser?.close();
  stop();
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
  Object.assign(process.env, previous);
}
