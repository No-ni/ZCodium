import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { resolve } from "node:path";
import { build, stop } from "esbuild";

const root = resolve(import.meta.dirname, "../..");
const { outputFiles } = await build({
  entryPoints: [resolve(import.meta.dirname, "fixtures/copy-conversation-markdown.jsx")],
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  alias: { "@": resolve(root, "packages/ui/src") },
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".css": "empty", ".png": "dataurl" },
});
stop();
const script = outputFiles[0].contents;
const server = createServer((request, response) => {
  if (request.url === "/fixture.js") {
    response.setHeader("Content-Type", "text/javascript");
    response.end(script);
  } else {
    response.setHeader("Content-Type", "text/html");
    response.end(
      '<!doctype html><meta name="viewport" content="width=device-width"><div id="root"></div><script type="module" src="/fixture.js"></script>',
    );
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  if (process.env.ZCODE_TEST_FIXTURE_ONLY) {
    console.log(`copy-conversation-markdown fixture: ${origin} (pid ${process.pid})`);
    await new Promise((resolveStop) => {
      process.once("SIGINT", resolveStop);
      process.once("SIGTERM", resolveStop);
    });
  } else {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.ZCODE_TEST_CHROMIUM_EXECUTABLE || undefined,
    });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    for (const locale of ["en-US", "zh-CN"]) {
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 850 });
        for (const mode of [
          "success",
          "formatting",
          "changed",
          "empty",
          "projected-empty",
          "clipboard-failure",
          "read-error",
          "both-fail",
          "no-session",
          "no-platform",
          "api-unavailable",
        ]) {
          await page.goto(`${origin}/?locale=${locale}&mode=${mode}&remote=1`);
          await page.getByTestId("open-menu").click();
          const copy = page.getByTestId("task-copy-markdown");
          const items = await page.getByRole("menuitem").allTextContents();
          const idLabel = locale === "zh-CN" ? "复制会话 ID" : "Copy session ID";
          assert.equal(
            items[items.indexOf(idLabel) + 1],
            locale === "zh-CN" ? "复制为 Markdown" : "Copy as Markdown",
          );
          if (mode === "no-session" || mode === "no-platform" || mode === "api-unavailable") {
            assert.equal(await copy.getAttribute("aria-disabled"), "true");
            assert.equal(await page.evaluate(() => window.copyFixture.reads.length), 0);
            continue;
          }
          await copy.focus();
          await page.keyboard.press("Enter");
          await page.waitForFunction(
            () => !window.copyFixture.pending && window.copyFixture.reads.length > 0,
          );
          const result = await page.evaluate(() => window.copyFixture);
          for (const read of result.reads) {
            assert.equal(read.sessionId, "session-a");
            assert.equal(read.workspaceIdentity, "remote-fixture");
            assert.equal(read.remoteSessionId, "remote-host");
          }
          assert.equal(result.submissions, 1);
          assert.equal(
            result.reads.length,
            mode === "changed"
              ? 2
              : mode === "read-error" ||
                  mode === "both-fail" ||
                  mode === "empty" ||
                  mode === "projected-empty"
                ? 1
                : 4,
          );
          if (mode === "success" || mode === "formatting") {
            assert.equal(result.writes, 1);
            assert.match(result.copied, /Earliest question/);
            assert.match(result.copied, /Latest answer/);
            assert.equal((result.copied.match(/^## (?:User|Assistant)$/gm) ?? []).length, 620);
            if (mode === "formatting")
              assert.match(result.copied, /file:\/\/\/C:\/Docs\/report%23draft%25\.pdf/);
          } else {
            assert.equal(result.writes, 0);
            assert.equal(result.copied, "previous clipboard");
          }
          const messages =
            locale === "zh-CN"
              ? {
                  success: "已复制为 Markdown",
                  formatting: "已复制为 Markdown",
                  changed: "会话内容在复制期间发生变化",
                  empty: "会话没有可复制的内容",
                  "projected-empty": "会话没有可复制的内容",
                  "clipboard-failure": "复制失败",
                  "read-error": "复制失败",
                  "both-fail": "复制失败",
                }
              : {
                  success: "Copied as Markdown",
                  formatting: "Copied as Markdown",
                  changed: "The conversation changed while copying",
                  empty: "This conversation has no content to copy",
                  "projected-empty": "This conversation has no content to copy",
                  "clipboard-failure": "Copy failed",
                  "read-error": "Copy failed",
                  "both-fail": "Copy failed",
                };
          await page.waitForFunction(
            (message) => document.body.textContent.includes(message),
            messages[mode],
          );
        }
      }
    }
    await page.goto(`${origin}/?mode=pending&remote=1`);
    await page.getByTestId("copy-twice").click();
    await page.waitForFunction(() => window.copyFixture.pending);
    assert.equal(await page.evaluate(() => window.copyFixture.submissions), 1);
    await page.getByTestId("switch-session").click();
    await page.getByTestId("open-menu").click();
    assert.equal(
      await page.getByTestId("task-copy-markdown").getAttribute("aria-disabled"),
      "true",
    );
    await page.keyboard.press("Escape");
    await page.getByTestId("resolve-read").click();
    await page.waitForFunction(() => !window.copyFixture.pending);
    const switched = await page.evaluate(() => window.copyFixture);
    assert.ok(switched.reads.every((read) => read.sessionId === "session-a"));
    assert.ok(switched.copied.startsWith("# Conversation A\n"));
    assert.equal(switched.writes, 1);
    await page.getByTestId("open-menu").click();
    await page.getByTestId("task-copy-markdown").click();
    await page.waitForFunction(
      () => window.copyFixture.writes === 2 && !window.copyFixture.pending,
    );
    assert.ok(
      (await page.evaluate(() => window.copyFixture.copied)).startsWith("# Conversation B\n"),
    );
    assert.deepEqual(errors, []);
    console.log(
      "copy-conversation-markdown: 44 menu cases and pending/session-switch checks passed",
    );
  }
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolveClose) => server.close(resolveClose));
}
