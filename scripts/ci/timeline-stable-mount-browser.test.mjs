import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright-core";
import { buildFixture, closeServer, startStaticServer } from "./terminal-render-browser.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const scrollSelector = '[data-testid="v4-timeline"]';
const turnSelector = (turn) => `[data-v4-turn-unit][data-turn-id="turn-${turn}"]`;

async function settle(page, frames = 12) {
  await page.evaluate(
    (count) =>
      new Promise((done) => {
        const next = () => (--count <= 0 ? done() : requestAnimationFrame(next));
        requestAnimationFrame(next);
      }),
    frames,
  );
}

async function change(page, action, argument) {
  const revision = await page.evaluate(() => window.timelineFixture.revision);
  await page.evaluate(({ action, argument }) => window.timelineFixture[action](argument), {
    action,
    argument,
  });
  await page.waitForFunction((previous) => window.timelineFixture.revision > previous, revision);
  await settle(page);
  if (action === "reset") await settle(page, 24);
}

async function metrics(page) {
  return page.locator(scrollSelector).evaluate((element) => ({
    top: element.scrollTop,
    height: element.scrollHeight,
    viewport: element.clientHeight,
    gap: element.scrollHeight - element.scrollTop - element.clientHeight,
  }));
}

async function capture(page, turn) {
  await page.evaluate((id) => window.timelineFixture.capture(id), turn);
}

async function identity(page) {
  return page.evaluate(() => window.timelineFixture.identity());
}

function assertRetained(actual, live, message) {
  assert.deepEqual(
    actual,
    {
      sameWrapper: true,
      sameGroup: true,
      sameQuery: true,
      sameBody: true,
      sameParent: true,
      removed: 0,
      live,
    },
    message,
  );
}

test(
  "timeline keeps visible turn identity across terminal layout and subsequent input",
  { timeout: 240_000 },
  async (t) => {
    const temporary = await mkdtemp(join(tmpdir(), "zcodium-timeline-mount-"));
    let server;
    let browser;
    const errors = [];
    const blockedRequests = [];
    try {
      // 只编译临时浏览器夹具，使用生产态 React，避免开发热更新改变提交/测高时序。
      const { buildDir } = await buildFixture({
        variant: "after",
        root,
        fixturePath: "packages/ui/test/timeline-stable-mount.html",
        tempRoot: temporary,
        baselineSources: new Map(),
      });
      const started = await startStaticServer(buildDir);
      server = started.server;
      const baseUrl = started.baseUrl.replace(/\/$/, "");
      browser = await chromium.launchPersistentContext(join(temporary, "browser-profile"), {
        channel: process.platform === "win32" ? "msedge" : "chrome",
        headless: true,
        viewport: { width: 1280, height: 900 },
      });
      await browser.route("**/*", (route) => {
        const url = route.request().url();
        if (url.startsWith(baseUrl + "/") || url.startsWith("data:") || url.startsWith("blob:"))
          return route.continue();
        blockedRequests.push(url);
        return route.abort();
      });
      const page = await browser.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${baseUrl}/packages/ui/test/timeline-stable-mount.html`, {
        timeout: 90_000,
      });
      await page.waitForFunction(() => window.timelineFixture?.revision > 0, undefined, {
        timeout: 90_000,
      });
      await settle(page);

      await t.test(
        "success, interruption, failure and the next turn retain the mounted subtree",
        async () => {
          for (const state of ["completedSuccess", "completedInterrupted", "failed"]) {
            await change(page, "reset", 40);
            await capture(page, 139);
            assertRetained(await identity(page), true, "initial live turn");
            const liveMetrics = await metrics(page);
            await change(page, "complete", state);
            assertRetained(await identity(page), false, `${state} must only change layout`);
            await settle(page, 24);
            const terminalMetrics = await metrics(page);
            assert.ok(
              terminalMetrics.gap <= 2,
              `terminal turn remains pinned: ${JSON.stringify({ state, liveMetrics, terminalMetrics })}`,
            );
            await change(page, "next");
            assertRetained(await identity(page), false, "next input must not defer the remount");
            assert.equal(await page.locator('[data-v4-running-live-tail="true"]').count(), 1);
          }
        },
      );

      await t.test(
        "ordinary streaming projection, resumed tail and narrow terminal retain the turn owner",
        async () => {
          for (const width of [1280, 390]) {
            await page.setViewportSize({ width, height: 900 });
            await change(page, "reset", 40);
            await change(page, "ordinaryStream");
            await capture(page, 139);
            await change(page, "complete", "completedSuccess");
            // 无 action 的流式正文会从过程区升为最终答复，内部落位按原有产品语义改变。
            // 外层 owner 与用户 query 必须保持；不能因整个 turn 重挂而掩盖这一区别。
            const { sameBody: _body, ...container } = await identity(page);
            assert.deepEqual(container, {
              sameWrapper: true,
              sameGroup: true,
              sameQuery: true,
              sameParent: true,
              removed: 0,
              live: false,
            });
            await capture(page, 139);
            await change(page, "resume");
            assert.equal(
              (await identity(page)).sameWrapper,
              true,
              "terminal → live keeps the row owner",
            );
            await change(page, "grow");
            assert.ok((await metrics(page)).gap <= 2, "resumed tail still measures and follows");
            await change(page, "complete", "completedInterrupted");
            assert.equal((await identity(page)).sameWrapper, true);
          }
          await page.setViewportSize({ width: 1280, height: 900 });
          await settle(page, 24);
        },
      );

      await t.test("streaming flow, code wrapping, resize and user scroll ownership", async () => {
        await change(page, "reset", 40);
        const before = await metrics(page);
        await change(page, "grow");
        const grown = await metrics(page);
        assert.ok(grown.height > before.height + 100);
        assert.ok(grown.gap <= 2, "streaming ResizeObserver follows before paint");
        const tail = page.locator(turnSelector(139));
        const wrapButton = tail.getByRole("button", { name: /wrap/i });
        assert.ok((await wrapButton.count()) > 0, "real code wrapping control is mounted");
        await wrapButton.first().click();
        assert.equal(await wrapButton.first().getAttribute("aria-pressed"), "true");
        await capture(page, 139);
        await change(page, "complete", "completedSuccess");
        assertRetained(await identity(page), false, "terminal retains the real message subtree");
        // streaming/static 保留原有解析边界，围栏内部可能重建；完成态控件仍可用，
        // 并且下一轮开始不应再次重置已处于 static 的围栏状态。
        await wrapButton.first().click();
        const pressed = await wrapButton.first().getAttribute("aria-pressed");
        const selectedText = await tail.evaluate((element) => {
          const source = element.querySelector("[data-code-snippet-source]");
          const text = source?.firstChild;
          if (!(text instanceof Text)) throw new Error("Expected selectable source text");
          const start = text.data.indexOf("stableMountProbe");
          const range = document.createRange();
          range.setStart(text, start);
          range.setEnd(text, start + "stableMountProbe".length);
          const selection = getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          window.timelineCodeSelection = { source, text, range };
          return selection.toString();
        });
        assert.equal(selectedText, "stableMountProbe");
        await change(page, "next");
        assertRetained(
          await identity(page),
          false,
          "next input preserves terminal message subtree",
        );
        assert.equal(await wrapButton.first().getAttribute("aria-pressed"), pressed);
        assert.deepEqual(
          await tail.evaluate((element) => {
            const { source, text, range } = window.timelineCodeSelection;
            const selection = getSelection();
            return {
              sameSource: element.querySelector("[data-code-snippet-source]") === source,
              sameText: source.firstChild === text,
              sameRange: selection.getRangeAt(0) === range,
              selected: selection.toString(),
            };
          }),
          { sameSource: true, sameText: true, sameRange: true, selected: "stableMountProbe" },
        );
        await page.setViewportSize({ width: 390, height: 720 });
        await settle(page, 24);
        assert.ok((await metrics(page)).gap <= 2, "narrow viewport remains pinned");
        await page.setViewportSize({ width: 1280, height: 900 });
        await settle(page, 24);
        await change(page, "reset", 40);
        // 同一个任务内登记 wheel 意图并上滚，再在 scroll 事件前结束回复。
        await page.locator(scrollSelector).evaluate((element) => {
          element.dispatchEvent(new WheelEvent("wheel", { deltaY: -300, bubbles: true }));
          element.scrollTop -= 300;
          const viewportTop = element.getBoundingClientRect().top;
          const anchor = [...element.querySelectorAll("[data-v4-turn-unit]")].find((row) => {
            const rect = row.getBoundingClientRect();
            return rect.top <= viewportTop && rect.bottom > viewportTop;
          });
          if (!anchor) throw new Error("No visible reading anchor");
          window.timelineReadingAnchor = {
            element: anchor,
            top: anchor.getBoundingClientRect().top,
          };
          window.timelineFixture.complete("completedSuccess");
        });
        await settle(page, 24);
        const readingDrift = () =>
          page.evaluate(() => {
            const { element, top } = window.timelineReadingAnchor;
            if (!element.isConnected) throw new Error("Reading anchor was evicted");
            return element.getBoundingClientRect().top - top;
          });
        const detachedTerminal = await metrics(page);
        assert.ok(
          Math.abs(await readingDrift()) <= 2 && detachedTerminal.gap > 100,
          `terminal must yield to unobserved upward scroll: ${JSON.stringify(detachedTerminal)}`,
        );
        await change(page, "next");
        await change(page, "grow");
        assert.ok(
          Math.abs(await readingDrift()) <= 2 && (await metrics(page)).gap > 100,
          "new output must preserve detached reading",
        );
      });

      await t.test(
        "history eviction, query navigation, prepend anchor and find ranges",
        async () => {
          await change(page, "reset", 80);
          await capture(page, 179);
          await change(page, "complete", "completedSuccess");
          assertRetained(await identity(page), false, "terminal at bottom");
          const mountedCount = () => page.locator("[data-v4-turn-unit]").count();
          assert.ok((await mountedCount()) < 30, "history remains virtualized");
          await page.evaluate(() => window.timelineFixture.jump(130));
          await page.locator('[data-row-id="521"]').waitFor();
          await settle(page);
          assert.equal(
            await page.locator(turnSelector(179)).count(),
            0,
            "terminal row is evicted outside overscan",
          );
          assert.equal((await identity(page)).sameWrapper, false);
          const anchorBefore = await page
            .locator('[data-row-id="521"]')
            .evaluate((element) => element.getBoundingClientRect().top);
          await change(page, "prepend");
          const anchorAfter = await page
            .locator('[data-row-id="521"]')
            .evaluate((element) => element.getBoundingClientRect().top);
          assert.ok(
            Math.abs(anchorAfter - anchorBefore) <= 2,
            `prepend anchor drift: ${anchorAfter - anchorBefore}px`,
          );
          await change(page, "search", "query stable 179");
          await page.locator('[data-row-id="717"]').waitFor();
          await settle(page);
          const find = await page.evaluate(() => {
            const highlights = CSS.highlights.get("zcode-v4-conversation-find-active");
            return {
              state: window.timelineFixture.find,
              ranges: highlights ? [...highlights].map((range) => range.toString()) : [],
            };
          });
          assert.equal(find.state?.matchCount, 1, "find reports one match");
          assert.deepEqual(find.ranges, ["query stable 179"]);
          // Range 的名字由既有高亮 owner 决定；遍历 registry 核对真实可见 query。
          const highlightedTexts = await page.evaluate(() =>
            [...CSS.highlights.values()].flatMap((highlight) =>
              [...highlight].map((range) => range.toString()),
            ),
          );
          assert.ok(
            highlightedTexts.includes("query stable 179"),
            JSON.stringify(highlightedTexts),
          );
          assert.ok((await mountedCount()) < 30);
          await page.evaluate(() => window.timelineFixture.bottom());
          await settle(page);
          assert.equal(
            (await identity(page)).sameWrapper,
            false,
            "returning from eviction may legitimately mount again",
          );
          assert.ok((await metrics(page)).gap <= 2);
        },
      );

      await t.test(
        "epoch and rewind invalidate identity; a session switch resets its scope",
        async () => {
          await change(page, "reset", 12);
          await capture(page, 111);
          await change(page, "epoch");
          assert.equal((await identity(page)).sameWrapper, false);
          await capture(page, 111);
          await change(page, "grow");
          assert.ok(
            (await metrics(page)).gap <= 2,
            "new epoch rebinds live measurement to its current DOM",
          );
          await change(page, "complete", "completedSuccess");
          assertRetained(
            await identity(page),
            false,
            "new epoch tail promotes using its current measured height",
          );
          await change(page, "rewind");
          assert.equal(await page.locator(turnSelector(111)).count(), 0);
          await capture(page, 110);
          await change(page, "session");
          assert.equal(
            (await identity(page)).sameWrapper,
            false,
            "session identity must isolate repeated row/turn IDs",
          );
          assert.ok((await metrics(page)).gap <= 2, "new session initializes following state");
        },
      );

      assert.deepEqual(errors, [], "browser runtime errors");
      assert.deepEqual(blockedRequests, [], "fixture made no external requests");
    } finally {
      await browser?.close();
      if (server) await closeServer(server);
      assert.equal(dirname(temporary), resolve(tmpdir()));
      assert.ok(basename(temporary).startsWith("zcodium-timeline-mount-"));
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
