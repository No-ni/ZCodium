import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "../..");
const result = await build({
  entryPoints: [resolve(root, "packages/ui/test/web-remote-control-window-sync.tsx")],
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  alias: { "@": resolve(root, "packages/ui/src") },
  define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
});
const server = createServer((request, response) => {
  response.setHeader(
    "Content-Type",
    request.url === "/fixture.js" ? "text/javascript" : "text/html",
  );
  response.end(
    request.url === "/fixture.js"
      ? result.outputFiles[0].contents
      : '<div id="root"></div><script type="module" src="/fixture.js"></script>',
  );
});
let browser;
try {
  await new Promise((yes) => server.listen(0, "127.0.0.1", yes));
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.ZCODE_TEST_CHROMIUM_EXECUTABLE || undefined,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole("button", { name: "打开二维码弹窗" }).waitFor();
  assert.equal(
    await page.evaluate(() => window.__windowSyncFixture.subscriptions.length),
    0,
    "idle mobile sync must not subscribe to Controller",
  );
  await page.evaluate(() => window.__windowSyncFixture.start());
  await page.waitForFunction(() =>
    window.__windowSyncFixture.writes.some(
      (write) => write.kind === "tasks" && write.payload.tasks.length === 2,
    ),
  );
  const first = await page.evaluate(
    () =>
      window.__windowSyncFixture.writes.filter((write) => write.kind === "tasks").at(-1).payload
        .tasks,
  );
  assert.deepEqual(
    first.map((task) => task.displayStatus),
    ["running", "running"],
  );
  await page.getByRole("button", { name: "打开二维码弹窗" }).click();
  await page.getByRole("button", { name: "关闭二维码弹窗" }).click();
  await page.evaluate(() => window.__windowSyncFixture.update());
  await page.waitForFunction(() =>
    window.__windowSyncFixture.writes
      .filter((write) => write.kind === "tasks")
      .at(-1)
      .payload.tasks.every((task) => task.title.endsWith("已更新")),
  );
  await page.evaluate(() => window.__windowSyncFixture.closeWorkspace());
  await page.waitForFunction(
    () =>
      window.__windowSyncFixture.writes.filter((write) => write.kind === "workspaces").at(-1)
        .payload.workspaces.length === 1,
  );
  const remaining = await page.evaluate(
    () =>
      window.__windowSyncFixture.writes.filter((write) => write.kind === "tasks").at(-1).payload
        .tasks,
  );
  assert.equal(remaining.length, 1);
  await page.evaluate(() => window.__windowSyncFixture.closeWorkspace());
  await page.waitForFunction(
    () => {
      const workspaces = window.__windowSyncFixture.writes
        .filter((write) => write.kind === "workspaces")
        .at(-1)?.payload.workspaces;
      const tasks = window.__windowSyncFixture.writes
        .filter((write) => write.kind === "tasks")
        .at(-1)?.payload.tasks;
      return workspaces?.length === 0 && tasks?.length === 0;
    },
    null,
    { timeout: 5_000 },
  );
  const cleared = await page.evaluate(() => ({
    workspaces: window.__windowSyncFixture.writes
      .filter((write) => write.kind === "workspaces")
      .at(-1),
    tasks: window.__windowSyncFixture.writes.filter((write) => write.kind === "tasks").at(-1),
  }));
  assert.deepEqual(cleared.workspaces.payload.workspaces, []);
  assert.deepEqual(cleared.tasks.payload.tasks, []);
  assert.equal(cleared.workspaces.payload.workspacePath, "/status-scope");
  assert.equal(cleared.workspaces.payload.workspaceIdentity, "status-identity");
  assert.equal(cleared.tasks.payload.workspacePath, "/status-scope");
  assert.equal(cleared.tasks.payload.workspaceIdentity, "status-identity");
  const beforeStop = await page.evaluate(() => {
    window.__windowSyncFixture.stop();
    return window.__windowSyncFixture.writes.length;
  });
  await page.getByRole("button", { name: "打开二维码弹窗" }).click();
  await page.evaluate(() => window.__windowSyncFixture.update());
  await page.getByRole("button", { name: "关闭二维码弹窗" }).click();
  assert.equal(
    await page.evaluate(() => window.__windowSyncFixture.writes.length),
    beforeStop,
    "stopped sync must not publish stale tasks",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS Chromium window sync: idle avoids subscriptions; all workspaces/pinned/live status; updates after QR dialog closes; workspace removal and final clear; stopped sync discards updates",
  );
} finally {
  await browser?.close();
  await new Promise((yes) => server.close(yes));
}
