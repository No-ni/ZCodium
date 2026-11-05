import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { build, stop } from "esbuild";
import { createProjectTestSandbox } from "./project-test-sandbox.mjs";
import { launchProjectTestPage } from "./project-test-browser.mjs";

const root = resolve(import.meta.dirname, "../..");
const sandbox = await createProjectTestSandbox("custom-feature-browser");
const { outputFiles } = await build({
  entryPoints: [join(import.meta.dirname, "fixtures/custom-feature-menus.jsx")],
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  alias: { "@": join(root, "packages/ui/src") },
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".css": "empty", ".png": "dataurl" },
});
stop();
const server = createServer((req, res) => {
  res.setHeader("Content-Type", req.url === "/fixture.js" ? "text/javascript" : "text/html");
  res.end(
    req.url === "/fixture.js"
      ? outputFiles[0].contents
      : '<!doctype html><div id="root"></div><script type="module" src="/fixture.js"></script>',
  );
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
let context;
try {
  console.log("custom-feature-menus: launching browser");
  context = await launchProjectTestPage(sandbox);
  console.log("custom-feature-menus: browser ready");
  const { page } = context;
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let menuCases = 0;
  for (const locale of ["en-US", "zh-CN"])
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 850 });
      for (const grouped of [false, true])
        for (const mode of [
          "success",
          "loading",
          "missing",
          "unsupported",
          "query-error",
          "open-failure",
          "open-throw",
          "remote",
        ]) {
          console.log(`menu case: ${locale}/${width}/${grouped ? "grouped" : "header"}/${mode}`);
          await page.goto(`${origin}/?locale=${locale}&mode=${mode}`);
          assert.equal(
            await page.evaluate(() => window.customFixture.configQueries),
            0,
            "closed menu does not query config",
          );
          await page
            .getByTestId(grouped ? "grouped-menu" : "open-menu")
            .click(grouped ? { button: "right" } : {});
          const item = page.getByTestId("task-provider-config");
          if (mode === "loading") {
            await page.waitForFunction(() => window.customFixture.loading, undefined, {
              timeout: 10000,
            });
            assert.equal(await item.getAttribute("aria-disabled"), "true");
            await page.keyboard.press("Escape");
            await page.getByTestId("release-config").click();
          } else {
            await page.waitForFunction(() => !window.customFixture.loading, undefined, {
              timeout: 10000,
            });
            const disabled = ["missing", "unsupported", "query-error"].includes(mode);
            assert.equal(await item.getAttribute("aria-disabled"), disabled ? "true" : null);
            if (disabled) {
              assert.ok(await item.getAttribute("title"));
              assert.deepEqual(await page.evaluate(() => window.customFixture.configOpens), []);
            } else {
              await item.focus();
              await page.keyboard.press("Enter");
              await page.waitForFunction(
                () => window.customFixture.configOpens.length === 1,
                undefined,
                { timeout: 10000 },
              );
              assert.deepEqual(await page.evaluate(() => window.customFixture.configOpens), [
                "/environment/runtime/provider/bundled/zcode-builtin.json",
              ]);
              if (mode === "open-failure" || mode === "open-throw")
                await page.waitForFunction(
                  (text) => document.body.textContent.includes(text),
                  locale === "zh-CN"
                    ? "无法打开 Provider 配置文件"
                    : "Could not open the provider config file",
                  { timeout: 10000 },
                );
            }
          }
          menuCases++;
        }
    }
  await page.goto(origin);
  for (const id of ["a", "b", "fallback", "remote"]) await page.getByTestId(`files-${id}`).click();
  await page.waitForFunction(() => window.customFixture.opens.length === 4);
  let value = await page.evaluate(() => window.customFixture);
  assert.deepEqual(
    value.opens.map((x) => x.workspacePath),
    [
      "/local/2026-11-05/task-a",
      "/local/2026-11-05/task-b",
      "/local/fallback",
      "/remote/2026-11-05/task-a",
    ],
  );
  const read = value.queries.find((x) => x.kind === "read");
  assert.equal(read.input.runtimePolicy, "existing-only");
  const remoteRead = value.queries.find((x) => x.host === "remote");
  assert.equal(remoteRead.input.workspaceIdentity, "remote-fixture");
  assert.equal(remoteRead.input.remoteSessionId, "remote-host");
  await page.getByTestId("files-offline").click();
  await page.waitForFunction(() => window.customFixture.errors.length === 1);
  assert.equal(
    await page.evaluate(() => window.customFixture.queries.length),
    value.queries.length,
  );
  await page.getByTestId("files-slow").click();
  await page.waitForFunction(() =>
    window.customFixture.queries.some((x) => x.input.sessionIds?.[0] === "slow"),
  );
  await page.getByTestId("files-b").click();
  await page.getByTestId("release-task").click();
  await page.waitForFunction(() => window.customFixture.opens.length === 5);
  assert.equal(
    await page.evaluate(() =>
      window.customFixture.opens.some((x) => x.workspacePath.endsWith("/slow")),
    ),
    false,
  );
  await page.getByTestId("files-remote-slow").click();
  await page.waitForFunction(() =>
    window.customFixture.queries.some(
      (x) => x.host === "remote" && x.input.sessionIds?.[0] === "slow",
    ),
  );
  await page.getByTestId("disconnect").click();
  await page.getByTestId("release-task").click();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(
    await page.evaluate(() => window.customFixture.opens.length),
    5,
    "断开的远端旧响应不能打开文件树",
  );
  await page.getByTestId("files-slow").click();
  await page.getByTestId("unmount-files").click();
  await page.getByTestId("release-task").click();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await page.evaluate(() => window.customFixture.opens.length), 5);
  assert.deepEqual(errors, []);
  console.log(
    `custom-feature-menus: ${menuCases} menu cases; exact local/remote cwd, fallback, offline, stale and unmount checks passed`,
  );
  console.log(`artifacts: ${sandbox.root}`);
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await context?.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
