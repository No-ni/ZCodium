import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { startProjectBrowserFixture } from "./project-browser-fixture.mjs";
import { assertProjectPath } from "./project-test-sandbox.mjs";

const electronExecutable = process.env.ZCODE_TEST_ELECTRON_EXECUTABLE;
const chromiumExecutable = process.env.ZCODE_TEST_CHROMIUM_EXECUTABLE;

async function closeBrowser(action, electronApp) {
  let timer;
  try {
    await Promise.race([
      action(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          electronApp?.process().kill();
          reject(new Error("PROJECT_BROWSER_PROCESS_CLOSE_TIMEOUT"));
        }, 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function browserFixture(options, verify) {
  const fixture = await startProjectBrowserFixture(options);
  let context;
  let electronApp;
  let page;
  let failure;
  const errors = [];
  const externalRequests = [];
  const requests = [];
  const secondaryErrors = [];
  let phase = "launch";
  console.log(`Browser fixture started: ${options.label}`);
  try {
    const { chromium, _electron } = await import("playwright-core");
    const profile = await assertProjectPath(join(fixture.sandbox.root, "browser-profile"));
    const downloadsPath = await assertProjectPath(join(fixture.sandbox.root, "downloads"));
    await mkdir(downloadsPath);
    if (electronExecutable) {
      const appPath = join(fixture.sandbox.root, "electron-fixture.cjs");
      await writeFile(
        appPath,
        `const { app, BrowserWindow } = require("electron");
app.setPath("userData", ${JSON.stringify(profile)});
app.setPath("sessionData", ${JSON.stringify(profile)});
app.setPath("crashDumps", ${JSON.stringify(join(fixture.sandbox.root, "crashes"))});
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
app.commandLine.appendSwitch("disable-sync");
app.whenReady().then(() => {
  const window = new BrowserWindow({ show: false, width: 1280, height: 900,
    webPreferences: { nodeIntegration: false, contextIsolation: true } });
  const session = window.webContents.session;
  globalThis.__fixtureBlockedOrigins = [];
  const origin = ${JSON.stringify(new URL(fixture.origin).origin)};
  session.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    if (url.protocol === "ws:") url.protocol = "http:";
    else if (url.protocol === "wss:") url.protocol = "https:";
    const allowed = ["data:", "blob:", "about:"].includes(url.protocol) || url.origin === origin;
    if (!allowed) globalThis.__fixtureBlockedOrigins.push(url.origin);
    callback({ cancel: !allowed });
  });
  session.setDownloadPath(${JSON.stringify(downloadsPath)});
  window.loadURL("about:blank");
  window.showInactive();
});
app.on("window-all-closed", () => app.quit());\n`,
        { flag: "wx" },
      );
      const env = { ...fixture.sandbox.env };
      // Electron 主进程不支持 Node Permission Model；实际写者仅是这个受控项目 profile 的夹具。
      delete env.NODE_OPTIONS;
      electronApp = await _electron.launch({
        executablePath: electronExecutable,
        args: [appPath],
        env,
        timeout: 30_000,
      });
      page = await electronApp.firstWindow({ timeout: 30_000 });
      context = page.context();
    } else {
      context = await chromium.launchPersistentContext(profile, {
        ...(chromiumExecutable
          ? { executablePath: chromiumExecutable }
          : {
              channel: process.platform === "win32" ? "msedge" : "chrome",
            }),
        headless: true,
        timeout: 30_000,
        viewport: { width: 1280, height: 900 },
        downloadsPath,
        env: fixture.sandbox.env,
        args: [
          "--disable-background-networking",
          "--disable-component-update",
          "--disable-sync",
          "--disable-breakpad",
          "--no-first-run",
          "--no-default-browser-check",
        ],
      });
    }
    // Electron 41 的 CDP Fetch 拦截会中止同源导航；原生 session 守卫已在加载前绑定。
    if (!electronApp)
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (
          ["data:", "blob:", "about:"].includes(url.protocol) ||
          url.origin === new URL(fixture.origin).origin
        )
          await route.continue();
        else {
          externalRequests.push(url.origin);
          await route.abort();
        }
      });
    context.setDefaultTimeout(20_000);
    context.setDefaultNavigationTimeout(45_000);
    page ??= await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("requestfailed", (request) =>
      requests.push({ url: request.url(), failure: request.failure()?.errorText }),
    );
    page.on("response", (response) => {
      if (response.status() >= 400)
        requests.push({ url: response.url(), status: response.status() });
    });
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    phase = "navigation";
    console.log(`Browser navigation: ${options.label}`);
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.setViewportSize({ width: 1280, height: 900 });
    phase = "interaction";
    console.log(`Browser interaction: ${options.label}`);
    await verify(page, fixture);
    if (electronApp)
      externalRequests.push(
        ...(await electronApp.evaluate(() => globalThis.__fixtureBlockedOrigins)),
      );
    assert.deepEqual(errors, [], "The fixture must not raise browser errors");
    assert.deepEqual(externalRequests, [], "The fixture must not request external resources");
    assert.deepEqual(requests, [], "The fixture must not have failed module or document requests");
  } catch (error) {
    failure = error;
    console.error(`Browser acceptance failed during ${phase}: ${error.message}`);
    // 截图失败不能遮掉原始导航/交互错误，先保存可机器读取的诊断再捕获附加证据。
    await writeFile(
      join(fixture.sandbox.root, "failure-diagnostics.json"),
      `${JSON.stringify({ phase, message: error.message, errors, externalRequests, requests }, null, 2)}\n`,
      { flag: "wx" },
    ).catch((captureError) => secondaryErrors.push(captureError));
    if (page && !page.isClosed()) {
      for (const capture of [
        async () => {
          const nodes = await page.evaluate(() =>
            [
              ...document.querySelectorAll(
                "main, main div, [data-testid], [data-focused], [role=menu], [role=menuitemradio]",
              ),
            ].map((node) => {
              const style = getComputedStyle(node);
              const rect = node.getBoundingClientRect();
              return {
                tag: node.tagName,
                id: node.getAttribute("data-testid"),
                role: node.getAttribute("role"),
                text: node.textContent?.slice(0, 200),
                style: node.getAttribute("style"),
                className: node.className,
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                display: style.display,
                visibility: style.visibility,
                position: style.position,
              };
            }),
          );
          await writeFile(
            join(fixture.sandbox.root, "failure-dom.json"),
            JSON.stringify(nodes, null, 2),
            { flag: "wx" },
          );
        },
        async () =>
          writeFile(
            join(fixture.sandbox.root, "failure-page.txt"),
            await page.locator("body").innerText({ timeout: 2_000 }),
            { flag: "wx" },
          ),
        async () =>
          page.screenshot({ path: join(fixture.sandbox.root, "failure.png"), timeout: 2_000 }),
      ]) {
        try {
          await capture();
        } catch (captureError) {
          secondaryErrors.push(captureError);
        }
      }
    }
  } finally {
    for (const close of [
      async () => {
        if (electronApp) await closeBrowser(() => electronApp.close(), electronApp);
        else if (context) await closeBrowser(() => context.close());
      },
      () => fixture.close(),
    ]) {
      try {
        await close();
      } catch (closeError) {
        if (failure) secondaryErrors.push(closeError);
        else failure = closeError;
      }
    }
  }
  await writeFile(
    join(fixture.sandbox.root, "browser-results.json"),
    `${JSON.stringify(
      {
        passed: !failure,
        phase,
        message: failure?.message,
        errors,
        externalRequests,
        requests,
        secondaryErrors: secondaryErrors.map((error) => error.message),
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  );
  console.log(`Browser evidence: ${fixture.sandbox.root}`);
  if (failure) throw failure;
}

const hostId = "side-pane-full-view-host";

test(
  "full view preserves the real editor, draft and panes through presentation changes",
  {
    timeout: 120_000,
  },
  async () => {
    await browserFixture(
      {
        label: "full-view-acceptance",
        entry: "packages/ui/test/adoption-full-view.html",
      },
      async (page, fixture) => {
        const host = page.getByTestId(hostId);
        const input = page.getByTestId("v4-composer-input");
        await input.waitFor();
        await input.fill("Synthetic draft stays in the same Lexical node");
        await page.evaluate(() => {
          window.__acceptanceEditor = document.querySelector('[data-testid="v4-composer-input"]');
          window.__acceptanceMounts = [
            ...document.querySelectorAll('output[aria-label^="Mount "]'),
          ].map((node) => node.textContent);
        });
        const assertEditor = async () => {
          assert.equal(
            await page.evaluate(
              () =>
                window.__acceptanceEditor ===
                document.querySelector('[data-testid="v4-composer-input"]'),
            ),
            true,
          );
          assert.equal(await input.textContent(), "Synthetic draft stays in the same Lexical node");
          assert.deepEqual(
            await page.evaluate(() =>
              [...document.querySelectorAll('output[aria-label^="Mount "]')].map(
                (node) => node.textContent,
              ),
            ),
            await page.evaluate(() => window.__acceptanceMounts),
          );
        };
        await page.getByRole("button", { name: "Toggle full view", exact: true }).click();
        await host.waitFor({ state: "visible" });
        await page.waitForFunction(
          () =>
            document
              .querySelector('[data-testid="side-pane-full-view-host"]')
              ?.getAttribute("data-side-pane-full-view-host") === "floating",
        );
        await assertEditor();
        await input.click();
        await page.getByTestId("side-pane-full-view-expand").click();
        await page.waitForFunction(
          () =>
            document
              .querySelector('[data-testid="side-pane-full-view-host"]')
              ?.getAttribute("data-floating") === "expanded",
        );
        await assertEditor();
        await page.getByTestId("side-pane-full-view-minimize").click();
        await page.getByTestId("side-pane-full-view-bubble").waitFor();
        await page.getByTestId("side-pane-full-view-bubble").focus();
        await page.keyboard.press("Enter");
        await input.waitFor({ state: "visible" });
        await assertEditor();
        await page.getByRole("button", { name: "Conversation surface", exact: true }).click();
        await page.waitForFunction(
          () =>
            document
              .querySelector('[data-testid="side-pane-full-view-host"]')
              ?.getAttribute("data-side-pane-full-view-host") === "conversation",
        );
        await assertEditor();
        await page.getByRole("button", { name: "Side surface", exact: true }).click();
        await input.click();
        await page.getByTestId("side-pane-full-view-minimize").click();
        await page.getByRole("button", { name: "Toggle permission", exact: true }).click();
        await page.getByRole("alert").waitFor();
        await page.waitForFunction(
          () =>
            document
              .querySelector('[data-testid="side-pane-full-view-host"]')
              ?.getAttribute("data-floating") === "collapsed",
        );
        await page.getByRole("button", { name: "Toggle permission", exact: true }).click();
        await page.getByRole("button", { name: "Toggle full view", exact: true }).click();
        await page.waitForFunction(
          () =>
            document
              .querySelector('[data-testid="side-pane-full-view-host"]')
              ?.getAttribute("data-side-pane-full-view-host") === "normal",
        );
        await assertEditor();
        await page.screenshot({ path: join(fixture.sandbox.root, "full-view-normal.png") });
      },
    );
  },
);

test(
  "combined menu binds model effort, rejects stale events and fits narrow viewports",
  {
    timeout: 120_000,
  },
  async () => {
    await browserFixture(
      {
        label: "model-menu-acceptance",
        entry: "packages/ui/test/adoption-model-menu.html",
      },
      async (page, fixture) => {
        const left = page.getByRole("region", { name: "Left", exact: true });
        const right = page.getByRole("region", { name: "Right", exact: true });
        const selection = left.locator('output[aria-label="Left selection"]');
        await page.waitForFunction(() =>
          document
            .querySelector('output[aria-label="Left selection"]')
            ?.textContent?.startsWith("ready:"),
        );
        await page.getByRole("button", { name: "Capture old A event Left", exact: true }).click();
        await left.getByTestId("chat-model-select-trigger").click();
        const selectB = page.getByRole("menuitemradio", { name: /Model B/ });
        await selectB.click();
        await page.waitForFunction(() =>
          document
            .querySelector('output[aria-label="Left selection"]')
            ?.textContent?.includes('"modelId":"Model B"'),
        );
        assert.equal(await page.getByTestId("composer-thought-slider").count(), 1);
        const slider = page.getByTestId("composer-thought-slider");
        await slider.focus();
        await page.keyboard.press("Home");
        await page.keyboard.press("ArrowRight");
        await page.waitForFunction(() =>
          document
            .querySelector('output[aria-label="Left selection"]')
            ?.textContent?.includes('"reasoningLevel":"medium"'),
        );
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "Deliver old A event Left", exact: true }).click();
        assert.match(await selection.textContent(), /"modelId":"Model B"/);
        assert.match(await selection.textContent(), /"reasoningLevel":"medium"/);
        assert.match(
          await right.locator('output[aria-label="Right selection"]').textContent(),
          /"modelId":"Model A"/,
        );
        await page.getByRole("button", { name: "Freeze Left submission", exact: true }).click();
        assert.match(
          await left.locator('output[aria-label="Left frozen"]').textContent(),
          /"reasoningLevel":"medium"/,
        );
        await page.setViewportSize({ width: 390, height: 844 });
        await left.getByTestId("chat-model-select-trigger").click();
        const menu = page.getByRole("menu");
        await menu.waitFor();
        const rect = await menu.boundingBox();
        assert.ok(
          rect && rect.x >= 0 && rect.x + rect.width <= 390,
          "The combined menu must fit the mobile-width viewport",
        );
        await page.screenshot({ path: join(fixture.sandbox.root, "model-menu-narrow.png") });
      },
    );
  },
);
