import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { createProjectTestSandbox } from "./project-test-sandbox.mjs";

const root = resolve(import.meta.dirname, "../..");
// 覆盖位必须在 sandbox 绑定前捕获：createProjectTestSandbox 会剥离 zcode_ 前缀键，
// 绑定后再读 process.env 恒为 undefined，等于写死这条固定浏览器入口。
const pinnedExecutable = process.env.ZCODE_TEST_CHROMIUM_EXECUTABLE || "";
// 浏览器写入必须限定在项目内中央 sandbox：profile/downloads/TEMP/HOME 全部绑定后再装载
// esbuild/playwright，避免依赖在 import 时捕获系统 TEMP（旧版 chromium.launch 的越界点）。
const sandbox = await createProjectTestSandbox("window-sync-smoke");
for (const key of Object.keys(process.env)) {
  if (!(key in sandbox.env)) delete process.env[key];
}
Object.assign(process.env, sandbox.env);
const { build } = await import("esbuild");
const { createServer } = await import("node:http");
const { chromium } = await import("playwright-core");

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
let context;
try {
  await new Promise((yes) => server.listen(0, "127.0.0.1", yes));
  const executablePath = pinnedExecutable || undefined;
  // CI 步骤已 playwright-core install chromium（与 mobile smoke 同口径）；本机 Windows 用固定 Edge。
  context = await chromium.launchPersistentContext(join(sandbox.root, "browser-profile"), {
    ...(executablePath
      ? { executablePath }
      : { channel: process.platform === "win32" ? "msedge" : "chromium" }),
    headless: true,
    timeout: 30_000,
    viewport: { width: 1280, height: 900 },
    downloadsPath: join(sandbox.root, "downloads"),
    env: sandbox.env,
    args: [
      // 无视觉验收的 headless 状态夹具不需要 GPU 渲染进程。
      "--disable-gpu",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-breakpad",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole("button", { name: "打开二维码弹窗" }).waitFor();
  assert.equal(
    await page.evaluate(() => window.__windowSyncFixture.subscriptions.length),
    0,
    "idle mobile sync must not subscribe to Controller",
  );
  assert.equal(
    await page.evaluate(() => window.__windowSyncFixture.listCalls.length),
    0,
    "idle with nonempty workspace scope must not query the Controller",
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
  // in-flight 迟到结果与 stop/restart：查询在途时停止远控，随后释放的“迟到结果”
  // 不得发布；重启后必须经原订阅与查询入口读取当前事实。
  const beforeFlight = await page.evaluate(() => {
    const fixture = window.__windowSyncFixture;
    fixture.block(true);
    return { lists: fixture.listCalls.length };
  });
  await page.evaluate(() => window.__windowSyncFixture.update());
  await page.waitForFunction(
    (count) => window.__windowSyncFixture.listCalls.length > count,
    beforeFlight.lists,
  );
  // 查询换代期间仍可能发布最后可信列表；以 stop 同步边界取样，不能拿查询前计数判迟到。
  const atStop = await page.evaluate(() => {
    const fixture = window.__windowSyncFixture;
    fixture.stop();
    const taskWrites = fixture.writes.filter((write) => write.kind === "tasks");
    return { taskWrites: taskWrites.length, tasks: taskWrites.at(-1).payload.tasks };
  });
  await page.waitForFunction(() => window.__windowSyncFixture.activeSubscriptions.size === 0);
  await page.evaluate(() => window.__windowSyncFixture.release("迟到结果"));
  const afterLate = await page.evaluate(() => {
    const fixture = window.__windowSyncFixture;
    const taskWrites = fixture.writes.filter((write) => write.kind === "tasks");
    return {
      taskWrites: taskWrites.length,
      lists: fixture.listCalls.length,
      tasks: taskWrites.at(-1).payload.tasks,
    };
  });
  assert.equal(
    afterLate.taskWrites,
    atStop.taskWrites,
    "stopped sync must discard the late in-flight result instead of publishing it",
  );
  assert.deepEqual(afterLate.tasks, atStop.tasks);
  assert.ok(afterLate.tasks.every((task) => !task.title.includes("迟到结果")));
  assert.equal(
    afterLate.lists,
    beforeFlight.lists + 1,
    "idle/stopped sync must not add queries while disabled",
  );
  await page.evaluate(() => {
    const fixture = window.__windowSyncFixture;
    fixture.block(false);
    fixture.update();
    fixture.start();
  });
  await page.waitForFunction(
    (count) =>
      window.__windowSyncFixture.writes.filter((write) => write.kind === "tasks").length > count,
    afterLate.taskWrites,
    { timeout: 5_000 },
  );
  const restarted = await page.evaluate(
    () =>
      window.__windowSyncFixture.writes.filter((write) => write.kind === "tasks").at(-1).payload
        .tasks,
  );
  assert.ok(
    restarted.length === 2 && restarted.every((task) => !task.title.includes("迟到结果")),
    "restart must publish current facts, not the late stale result",
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
    "PASS Chromium window sync: idle avoids subscriptions and queries with nonempty scope; all workspaces/pinned/live status; updates after QR dialog closes; in-flight late result discarded across stop/restart; workspace removal and final clear; stopped sync discards updates",
  );
} finally {
  await context?.close();
  await new Promise((yes) => server.close(yes));
}
