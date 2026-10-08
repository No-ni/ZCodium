import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "../..");
const { outputFiles } = await build({
  entryPoints: [resolve(import.meta.dirname, "fixtures/storage-scan-lifecycle.jsx")],
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  alias: { "@": resolve(root, "packages/ui/src") },
  define: { "process.env.NODE_ENV": '"production"' },
});
const server = createServer((request, response) => {
  response.setHeader(
    "Content-Type",
    request.url === "/fixture.js" ? "text/javascript" : "text/html",
  );
  response.end(
    request.url === "/fixture.js"
      ? outputFiles[0].contents
      : '<!doctype html><div id="root"></div><script type="module" src="/fixture.js"></script>',
  );
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.ZCODE_TEST_CHROMIUM_EXECUTABLE || undefined,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const open = async () => {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole("button", { name: "Storage", exact: true }).click();
    await page.waitForFunction(() => window.storageScanFixture.starts.length === 1);
  };
  const cancelArrived = (id) =>
    page.waitForFunction((id) => window.storageScanFixture.cancellations.includes(id), id, {
      timeout: 3000,
    });
  // bridge 记录取消早于 React 提交，CI 曾读到旧的 true；按可见状态同步，不用固定延时。
  const scanningStopped = () =>
    page.waitForFunction(
      () => document.querySelector('[data-testid="scanning"]')?.textContent === "false",
      undefined,
      { timeout: 3000 },
    );

  await open();
  await page.getByRole("button", { name: "Other tab" }).click();
  await page.evaluate(() => window.storageScanFixture.resolve(0));
  await cancelArrived("scan-0");
  await scanningStopped();
  assert.equal(await page.getByTestId("scanning").textContent(), "false");

  for (const oldResult of ["resolve", "reject"]) {
    await open();
    await page.getByRole("button", { name: "Other tab" }).click();
    await page.getByRole("button", { name: "Storage", exact: true }).click();
    await page.waitForFunction(() => window.storageScanFixture.starts.length === 2);
    await page.evaluate(() => window.storageScanFixture.resolve(1));
    await page.waitForFunction(
      () => document.querySelector('[data-testid="scanning"]').textContent === "true",
    );
    await page.evaluate((method) => window.storageScanFixture[method](0), oldResult);
    if (oldResult === "resolve") await cancelArrived("scan-0");
    assert.equal(await page.getByTestId("scanning").textContent(), "true");
    await page.evaluate(() => window.storageScanFixture.publish(1));
    await page.waitForFunction(
      () => document.querySelector('[data-testid="snapshot"]').textContent === "scan-1",
    );
    await scanningStopped();
    assert.equal(await page.getByTestId("scanning").textContent(), "false");
  }

  await open();
  await page.getByRole("button", { name: "Unmount" }).click();
  await page.evaluate(() => window.storageScanFixture.resolve(0));
  await cancelArrived("scan-0");

  await open();
  await page.evaluate(() => window.storageScanFixture.resolve(0));
  await page.getByRole("button", { name: "Clean", exact: true }).click();
  await page.getByRole("button", { name: "Other tab" }).click();
  await page.evaluate(() => window.storageScanFixture.finishClean());
  await scanningStopped();
  assert.equal(await page.evaluate(() => window.storageScanFixture.starts.length), 1);
  assert.equal(await page.getByTestId("scanning").textContent(), "false");

  // 虚拟时钟验证原有 60 秒规则，避免实际等待或用短超时改变产品时序。
  await page.clock.install();
  await open();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.clock.runFor(60_000);
  await page.evaluate(() => window.storageScanFixture.resolve(0));
  await cancelArrived("scan-0");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForFunction(() => window.storageScanFixture.starts.length === 2);
  await page.evaluate(() => window.storageScanFixture.resolve(1));
  await page.evaluate(() => window.storageScanFixture.publish(1));
  await scanningStopped();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.clock.runFor(60_000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  assert.equal(await page.evaluate(() => window.storageScanFixture.starts.length), 2);
  assert.deepEqual(errors, []);
  console.log(
    "Storage lifecycle browser checks passed: leave, re-enter, stale error, unmount, clean, pending blur and idle focus.",
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
