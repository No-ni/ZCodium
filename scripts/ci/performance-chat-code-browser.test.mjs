import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../../", import.meta.url));
const uiSource = resolve(root, "packages/ui/src");
const fixturePath = "packages/ui/test/performance-chat-code.html";

async function waitForSnippets(page, count = 240) {
  await page.waitForFunction(
    (expected) => window.performanceChatCode?.snapshot().snippets === expected,
    count,
    { timeout: 30_000 },
  );
}

async function waitForSharedCodeHintClosed(page) {
  await page.locator("[data-code-block-shared-hint-anchor]").waitFor({ state: "detached" });
  await page.getByRole("tooltip").waitFor({ state: "detached" });
}

async function waitForSharedCodeHint(page, text) {
  await page.waitForFunction(
    (expected) => document.querySelector('[role="tooltip"]')?.textContent?.trim() === expected,
    text,
  );
}

async function readOverlayLayout(page) {
  return page.evaluate(() => {
    const snippet = document.querySelector("[data-code-snippet]");
    const source = snippet?.querySelector("[data-code-snippet-source]");
    const sourcePre = source?.closest("pre");
    const overlay = snippet?.querySelector("[data-code-snippet-highlight]");
    if (!snippet || !source || !sourcePre || !overlay) return null;
    const sourceRect = sourcePre.getBoundingClientRect();
    const overlayRect = overlay.getBoundingClientRect();
    const sourceStyle = getComputedStyle(sourcePre);
    const overlayStyle = getComputedStyle(overlay);
    const characterRect = (root, offset) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && offset >= node.textContent.length) {
        offset -= node.textContent.length;
        node = walker.nextNode();
      }
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + 1);
      return range.getBoundingClientRect();
    };
    const text = source.textContent;
    const probes = [text.indexOf("const"), text.indexOf("中文"), text.lastIndexOf("中")]
      .filter((offset) => offset >= 0)
      .map((offset) => {
        const rawRect = characterRect(source, offset);
        const tokenRect = characterRect(overlay, offset);
        return Math.max(Math.abs(rawRect.x - tokenRect.x), Math.abs(rawRect.y - tokenRect.y));
      });
    return {
      maxCharacterDrift: Math.max(0, ...probes),
      topDelta: Math.abs(sourceRect.top - overlayRect.top),
      leftDelta: Math.abs(sourceRect.left - overlayRect.left),
      widthDelta: Math.abs(sourceRect.width - overlayRect.width),
      heightDelta: Math.abs(sourceRect.height - overlayRect.height),
      sourceFont: sourceStyle.font,
      overlayFont: overlayStyle.font,
      sourceLineHeight: sourceStyle.lineHeight,
      overlayLineHeight: overlayStyle.lineHeight,
      sourceWhiteSpace: sourceStyle.whiteSpace,
      overlayWhiteSpace: overlayStyle.whiteSpace,
      ariaHidden: overlay.getAttribute("aria-hidden"),
      ignoredByFind: overlay.getAttribute("data-conversation-find-ignore"),
      inert: overlay.hasAttribute("inert"),
      sourceText: source.textContent,
      overlayText: overlay.textContent,
      scrollWidth: snippet.scrollWidth,
      clientWidth: snippet.clientWidth,
    };
  });
}

test(
  "real MessageResponse keeps 240 code snippets bounded and interactive",
  { timeout: 120_000 },
  async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "zcodium-chat-code-vite-"));
    const blockedRequests = [];
    const pageErrors = [];
    let server;
    let browser;
    let context;
    try {
      server = await createServer({
        configFile: false,
        root,
        cacheDir,
        // HMR 关闭时不能靠重载恢复过期依赖 URL；显式依赖在 listen 前完成，不再动态重建。
        optimizeDeps: {
          noDiscovery: true,
          include: [
            "react",
            "react-dom",
            "react-dom/client",
            "react/jsx-runtime",
            "react/jsx-dev-runtime",
            "@pierre/diffs",
            "@pierre/diffs/react",
            "@streamdown/cjk",
            "@streamdown/code",
            "@streamdown/math",
            "@streamdown/mermaid",
            "class-variance-authority",
            "clsx",
            "lucide-react",
            "radix-ui",
            "remark-cjk-friendly-gfm-strikethrough",
            "@zcode/ui > shiki",
            "streamdown",
            "tailwind-merge",
            "zod",
            "@zcode/ui > zustand",
          ],
        },
        plugins: [react(), tailwindcss()],
        resolve: {
          alias: { "@": uiSource },
          dedupe: ["react", "react-dom"],
        },
        server: { host: "127.0.0.1", port: 0, hmr: false },
        logLevel: "error",
      });
      await server.listen();
      const baseUrl = server.resolvedUrls.local[0];
      const origin = new URL(baseUrl);
      browser = await chromium.launch({
        channel: process.platform === "win32" ? "msedge" : "chrome",
        headless: true,
      });
      context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await context.addInitScript(() => {
        // 暂存真实 IO 通知，先建立原文 Range，再启动真实 Shiki；不替换产品高亮器。
        const NativeObserver = window.IntersectionObserver;
        let holdVisibility = true;
        const pendingVisibility = [];
        window.IntersectionObserver = class extends NativeObserver {
          constructor(callback, options) {
            super((entries, observer) => {
              if (holdVisibility) pendingVisibility.push(() => callback(entries, observer));
              else callback(entries, observer);
            }, options);
          }
        };
        window.__releaseChatCodeVisibility = () => {
          holdVisibility = false;
          for (const notify of pendingVisibility.splice(0)) notify();
        };
        const writes = [];
        Object.defineProperty(window, "__chatCodeClipboardWrites", {
          configurable: true,
          value: writes,
        });
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: async (text) => writes.push(text) },
        });
      });
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        const local = url.hostname === origin.hostname && url.port === origin.port;
        if (local || url.protocol === "data:" || url.protocol === "blob:") {
          await route.continue();
          return;
        }
        blockedRequests.push(url.href);
        await route.abort();
      });

      const page = await context.newPage();
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto(new URL(`${fixturePath}?mode=static`, baseUrl).href, { waitUntil: "commit" });
      await page.waitForFunction(() => window.performanceChatCode?.ready === true, undefined, {
        timeout: 60_000,
      });
      await waitForSnippets(page);
      assert.equal(await page.locator("[data-code-snippet-highlight]").count(), 0);
      assert.equal(
        (await page.evaluate(() => window.performanceChatCode.captureRange())).selectedText,
        "foo.bar",
      );
      await page.evaluate(() => window.__releaseChatCodeVisibility());
      await page.locator("[data-code-snippet-highlight]").first().waitFor({ timeout: 30_000 });
      const highlightedRange = await page.evaluate(() => window.performanceChatCode.rangeState());
      assert.equal(highlightedRange.sameSource, true);
      assert.equal(highlightedRange.sameTextNode, true);
      assert.equal(highlightedRange.sameRange, true);
      assert.equal(highlightedRange.rangeText, "foo.bar");

      const initial = await page.evaluate(() => window.performanceChatCode.snapshot());
      assert.equal(await page.evaluate(() => window.performanceChatCode.payloadLength), 34_122);
      assert.equal(initial.codeBlocks, 240);
      assert.equal(initial.sourceElements, 240);
      assert.equal(initial.viewerContainerCount, 0);
      assert.equal(initial.shadowRootCount, 0);
      assert.ok(initial.highlights > 0, "visible completed code should receive syntax tokens");
      assert.ok(initial.highlights < 32, "offscreen code must not create token DOM");
      assert.equal(initial.highlightedOffscreen, 0);

      const messageRow = page.locator("#message-row");
      const firstWrapButton = page.getByRole("button", { name: "Wrap lines" }).first();
      const firstCopyButton = page.getByRole("button", { name: "Copy code" }).first();
      const firstWrapButtonNode = await firstWrapButton.elementHandle();
      const firstCopyButtonNode = await firstCopyButton.elementHandle();
      assert.ok(firstWrapButtonNode && firstCopyButtonNode);
      assert.equal(await messageRow.locator('[data-slot="tooltip-trigger"]').count(), 0);

      const existingDescriptionId = "performance-code-hint-existing-description";
      await page.evaluate((id) => {
        const description = document.createElement("span");
        description.id = id;
        description.hidden = true;
        description.textContent = "Existing code control description";
        document.body.append(description);
      }, existingDescriptionId);
      await firstWrapButton.evaluate((button, id) => {
        button.setAttribute("aria-describedby", id);
      }, existingDescriptionId);

      const sharedHintAnchor = page.locator("[data-code-block-shared-hint-anchor]");
      const sharedHintTooltip = page.getByRole("tooltip");
      await firstWrapButton.hover();
      await sharedHintAnchor.waitFor({ state: "attached" });
      await sharedHintTooltip.waitFor({ state: "visible" });
      assert.equal(await sharedHintAnchor.count(), 1);
      assert.equal(await sharedHintTooltip.count(), 1);
      assert.equal((await sharedHintTooltip.innerText()).trim(), "Wrap lines");
      const wrapHintId = await sharedHintTooltip.getAttribute("id");
      assert.ok(wrapHintId);
      assert.equal(await messageRow.locator('[data-slot="tooltip-trigger"]').count(), 0);
      const wrapDescribedBy = (await firstWrapButton.getAttribute("aria-describedby")) ?? "";
      assert.ok(wrapDescribedBy.split(/\s+/).includes(existingDescriptionId));
      assert.ok(wrapDescribedBy.split(/\s+/).includes(wrapHintId));

      await firstCopyButton.hover();
      await waitForSharedCodeHint(page, "Copy code");
      await sharedHintTooltip.waitFor({ state: "visible" });
      assert.equal(await sharedHintAnchor.count(), 1);
      assert.equal(await sharedHintTooltip.count(), 1);
      assert.equal((await sharedHintTooltip.innerText()).trim(), "Copy code");
      const copyHintId = await sharedHintTooltip.getAttribute("id");
      assert.ok(copyHintId);
      assert.equal(await firstWrapButton.getAttribute("aria-describedby"), existingDescriptionId);
      const copyDescribedBy = (await firstCopyButton.getAttribute("aria-describedby")) ?? "";
      assert.ok(copyDescribedBy.split(/\s+/).includes(copyHintId));

      await page.evaluate(() => {
        const oldButton = document.querySelector('#message-row button[aria-label="Wrap lines"]');
        const currentButton = document.querySelector('#message-row button[aria-label="Copy code"]');
        oldButton?.dispatchEvent(
          new PointerEvent("pointerout", {
            bubbles: true,
            composed: true,
            pointerType: "mouse",
            relatedTarget: currentButton,
          }),
        );
      });
      await waitForSharedCodeHint(page, "Copy code");
      assert.equal(await sharedHintTooltip.count(), 1);
      assert.ok(
        ((await firstCopyButton.getAttribute("aria-describedby")) ?? "")
          .split(/\s+/)
          .includes(copyHintId),
      );

      await page.locator("#fixture-controls").hover();
      await waitForSharedCodeHintClosed(page);
      assert.equal(await sharedHintAnchor.count(), 0);
      assert.equal(await firstWrapButton.getAttribute("aria-describedby"), existingDescriptionId);
      assert.equal(await firstCopyButton.getAttribute("aria-describedby"), null);

      await firstWrapButton.focus();
      await sharedHintTooltip.waitFor({ state: "visible" });
      assert.equal(
        await firstWrapButton.evaluate((button) => button === document.activeElement),
        true,
      );
      assert.equal((await sharedHintTooltip.innerText()).trim(), "Wrap lines");
      await page.keyboard.press("Tab");
      await page.waitForFunction(
        () =>
          document.activeElement?.getAttribute("aria-label") === "Copy code" &&
          document.querySelector('[role="tooltip"]')?.textContent?.trim() === "Copy code",
      );
      assert.equal(await sharedHintAnchor.count(), 1);
      assert.equal(await sharedHintTooltip.count(), 1);
      assert.equal(
        await firstCopyButton.evaluate((button) => button === document.activeElement),
        true,
      );
      const focusedCopyHintId = await sharedHintTooltip.getAttribute("id");
      assert.ok(focusedCopyHintId);
      assert.equal(await firstWrapButton.getAttribute("aria-describedby"), existingDescriptionId);
      assert.ok(
        ((await firstCopyButton.getAttribute("aria-describedby")) ?? "")
          .split(/\s+/)
          .includes(focusedCopyHintId),
      );
      await page.keyboard.press("Escape");
      await waitForSharedCodeHintClosed(page);
      assert.equal(
        await firstCopyButton.evaluate((button) => button === document.activeElement),
        true,
      );
      assert.equal(await firstWrapButton.getAttribute("aria-describedby"), existingDescriptionId);
      assert.equal(await firstCopyButton.getAttribute("aria-describedby"), null);

      // Escape must stay dismissed when the pointer leaves a different hovered control.
      await firstWrapButton.hover();
      await sharedHintTooltip.waitFor({ state: "visible" });
      await page.keyboard.press("Escape");
      await waitForSharedCodeHintClosed(page);
      await page.locator("#fixture-controls").hover();
      await waitForSharedCodeHintClosed(page);
      assert.equal(await sharedHintAnchor.count(), 0);
      assert.equal(
        await firstCopyButton.evaluate((button) => button === document.activeElement),
        true,
      );
      await page.keyboard.press("a");
      assert.equal(await sharedHintAnchor.count(), 0);
      assert.equal(
        await firstCopyButton.evaluate((button) => button === document.activeElement),
        true,
      );

      await firstCopyButton.evaluate((button) => button.blur());
      await firstWrapButton.focus();
      await sharedHintTooltip.waitFor({ state: "visible" });
      assert.equal((await sharedHintTooltip.innerText()).trim(), "Wrap lines");
      assert.equal(
        await firstWrapButton.evaluate((button) => button === document.activeElement),
        true,
      );
      await firstWrapButton.evaluate((button) => button.blur());
      await waitForSharedCodeHintClosed(page);
      assert.equal(await firstWrapButton.getAttribute("aria-describedby"), existingDescriptionId);
      await firstWrapButton.evaluate((button) => button.removeAttribute("aria-describedby"));
      await page.evaluate((id) => document.getElementById(id)?.remove(), existingDescriptionId);

      await page.locator("#fixture-controls").hover();
      await firstWrapButton.hover();
      await sharedHintTooltip.waitFor({ state: "visible" });
      await page.locator("#message-scroll").evaluate((element) => {
        element.scrollTop += 5;
      });
      await waitForSharedCodeHintClosed(page);
      await page.locator("#message-scroll").evaluate((element) => {
        element.scrollTop = 0;
      });

      await page.locator("#fixture-controls").hover();
      await firstWrapButton.hover();
      await sharedHintTooltip.waitFor({ state: "visible" });
      await page.setViewportSize({ width: 400, height: 844 });
      await waitForSharedCodeHintClosed(page);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator("#message-scroll").evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.locator("#fixture-controls").hover();

      for (const viewport of [
        { width: 390, height: 844 },
        { width: 1280, height: 900 },
      ]) {
        await page.setViewportSize(viewport);
        const snippet = page.locator("[data-code-snippet]").first();
        const beforeWrap = await snippet.evaluate((element) => ({
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        }));
        assert.ok(
          beforeWrap.scrollWidth > beforeWrap.clientWidth,
          `long code should scroll horizontally at ${viewport.width}px`,
        );
        const wrapButton = page.getByRole("button", { name: "Wrap lines" }).first();
        await wrapButton.click();
        await page.waitForFunction(
          () =>
            getComputedStyle(document.querySelector("[data-code-snippet-source]")?.closest("pre"))
              .whiteSpace === "pre-wrap",
        );
        const wrapped = await snippet.evaluate((element) => ({
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        }));
        assert.ok(wrapped.scrollWidth <= wrapped.clientWidth);
        const layout = await readOverlayLayout(page);
        assert.ok(layout);
        assert.ok(layout.topDelta <= 1 && layout.leftDelta <= 1);
        assert.ok(layout.widthDelta <= 1 && layout.heightDelta <= 1);
        assert.ok(layout.maxCharacterDrift <= 1, JSON.stringify(layout));
        assert.equal(layout.sourceFont, layout.overlayFont);
        assert.equal(layout.sourceLineHeight, layout.overlayLineHeight);
        assert.equal(layout.sourceWhiteSpace, "pre-wrap");
        assert.equal(layout.overlayWhiteSpace, "pre-wrap");
        assert.equal(layout.ariaHidden, "true");
        assert.equal(layout.ignoredByFind, "true");
        assert.equal(layout.inert, true);
        assert.equal(layout.sourceText, layout.overlayText);
        await wrapButton.click();
        await page.waitForFunction(
          () =>
            getComputedStyle(document.querySelector("[data-code-snippet-source]")?.closest("pre"))
              .whiteSpace === "pre",
        );
      }

      const firstSourceText = await page
        .locator("[data-code-snippet-source]")
        .first()
        .textContent();
      await page.getByRole("button", { name: "Copy code" }).first().click();
      await page.waitForFunction(() => window.__chatCodeClipboardWrites?.length === 1);
      assert.equal(
        await page.evaluate(() => window.__chatCodeClipboardWrites.at(-1)),
        firstSourceText,
      );
      assert.equal(
        await firstWrapButtonNode.evaluate(
          (button) =>
            button.isConnected &&
            button === document.querySelector('#message-row button[aria-label="Wrap lines"]'),
        ),
        true,
      );
      assert.equal(
        await firstCopyButtonNode.evaluate(
          (button) =>
            button.isConnected &&
            button === document.querySelector('#message-row button[aria-label="Copy code"]'),
        ),
        true,
      );

      const nativeFind = await page.evaluate(() => {
        window.getSelection()?.removeAllRanges();
        const found = window.find("foo.bar");
        const selection = window.getSelection();
        const range = selection?.rangeCount === 1 ? selection.getRangeAt(0) : null;
        return {
          found,
          selectedText: selection?.toString() ?? "",
          singleRange: selection?.rangeCount === 1,
          selectionInSource: Boolean(
            range?.startContainer.parentElement?.closest("[data-code-snippet-source]"),
          ),
        };
      });
      assert.equal(nativeFind.found, true);
      assert.equal(nativeFind.selectedText, "foo.bar");
      assert.equal(nativeFind.singleRange, true);
      assert.equal(nativeFind.selectionInSource, true);
      const rangeCapture = await page.evaluate(() => window.performanceChatCode.captureRange());
      assert.equal(rangeCapture.selectedText, "foo.bar");
      const appFind = await page.evaluate(() => window.performanceChatCode.findMarker());
      assert.equal(appFind.available, true);
      assert.equal(appFind.count, 1, "the token layer must not add a second conversation match");
      assert.equal(appFind.activeText, "foo.bar");
      assert.equal(appFind.activeInSource, true);
      await page.evaluate(() => window.performanceChatCode.clearFind());

      const lightColor = await page
        .locator("[data-code-snippet-highlight]")
        .first()
        .evaluate((element) => getComputedStyle(element).color);
      await page.evaluate(() => window.performanceChatCode.setTheme("dark"));
      await page.waitForFunction(
        (previous) => {
          const current = document.querySelector("[data-code-snippet-highlight]");
          return current && getComputedStyle(current).color !== previous;
        },
        lightColor,
        { timeout: 30_000 },
      );
      const darkColor = await page
        .locator("[data-code-snippet-highlight]")
        .first()
        .evaluate((element) => getComputedStyle(element).color);
      assert.notEqual(darkColor, lightColor);
      const themedLayout = await readOverlayLayout(page);
      assert.ok(themedLayout);
      assert.ok(themedLayout.topDelta <= 1 && themedLayout.leftDelta <= 1);

      await page.evaluate(() => window.performanceChatCode.captureRange());
      await page.evaluate(() => window.performanceChatCode.scrollToBlock(239));
      await page.waitForFunction(
        () =>
          !document
            .querySelectorAll("[data-code-snippet]")
            .item(0)
            ?.querySelector("[data-code-snippet-highlight]") &&
          Boolean(
            document
              .querySelectorAll("[data-code-snippet]")
              .item(239)
              ?.querySelector("[data-code-snippet-highlight]"),
          ),
        undefined,
        { timeout: 30_000 },
      );
      const rangeAfterEviction = await page.evaluate(() => window.performanceChatCode.rangeState());
      assert.equal(rangeAfterEviction.sameSource, true);
      assert.equal(rangeAfterEviction.sameTextNode, true);
      assert.equal(rangeAfterEviction.sameRange, true);
      assert.equal(rangeAfterEviction.rangeText, "foo.bar");
      assert.equal(rangeAfterEviction.sourceConnected, true);

      await page.evaluate(() => window.performanceChatCode.moveToHistory());
      await page.waitForFunction(
        () => document.querySelector("#history-root [data-row-id]") !== null,
      );
      await waitForSnippets(page);
      await page.locator("#message-scroll").evaluate((element) => {
        element.scrollTop = 0;
      });
      // locator 的 visible 只检查 DOM/CSS，不代表进入视口；等待顶部片段的实际高亮恢复。
      await page.waitForFunction(
        () =>
          document
            .querySelector("#history-root [data-code-snippet]")
            ?.querySelector("[data-code-snippet-highlight]"),
        undefined,
        { timeout: 30_000 },
      );
      const history = await page.evaluate(() => window.performanceChatCode.snapshot());
      assert.equal(history.codeBlocks, 240);
      assert.equal(history.shadowRootCount, 0);
      assert.ok(history.highlights > 0 && history.highlights < 32, JSON.stringify(history));

      const streamingPage = await context.newPage();
      streamingPage.on("pageerror", (error) => pageErrors.push(error.message));
      await streamingPage.goto(new URL(`${fixturePath}?mode=streaming`, baseUrl).href, {
        waitUntil: "commit",
      });
      await streamingPage.waitForFunction(() => window.performanceChatCode?.ready === true);
      await waitForSnippets(streamingPage);
      await streamingPage.evaluate(() => window.__releaseChatCodeVisibility());
      await streamingPage.evaluate(
        () =>
          new Promise((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      const streaming = await streamingPage.evaluate(() => window.performanceChatCode.snapshot());
      assert.equal(streaming.codeBlocks, 240);
      assert.equal(streaming.highlights, 0, "streaming code stays as selectable source text");
      const streamingRange = await streamingPage.evaluate(() =>
        window.performanceChatCode.captureRange(),
      );
      assert.equal(streamingRange.selectedText, "foo.bar");
      await streamingPage.evaluate(() => window.performanceChatCode.completeStream());
      await streamingPage.locator("[data-code-snippet-highlight]").first().waitFor({
        timeout: 30_000,
      });
      const afterCompletion = await streamingPage.evaluate(() => ({
        snapshot: window.performanceChatCode.snapshot(),
        sourceText: document.querySelector("[data-code-snippet-source]")?.textContent ?? "",
        measures: [...window.performanceChatCode.measures],
      }));
      assert.equal(afterCompletion.snapshot.codeBlocks, 240);
      assert.equal(afterCompletion.snapshot.sourceElements, 240);
      assert.equal(afterCompletion.snapshot.viewerContainerCount, 0);
      assert.ok(afterCompletion.snapshot.highlights > 0);
      assert.equal(afterCompletion.sourceText, streamingRange.sourceText);
      assert.match(afterCompletion.sourceText, /foo\.bar/);

      // 复用已完成真实 Shiki 初始化的页面，避免加载延迟掩盖误启动高亮。
      const unicodeCode = '\t// 中文、空行与 emoji 🧪\n\nconst value = "' + "中".repeat(60) + '";';
      await page.evaluate((code) => {
        window.performanceChatCode.replaceMarkdown("```typescript\n" + code + "\n```");
        window.performanceChatCode.setFontSize(20);
      }, unicodeCode);
      await page.waitForFunction(
        (code) => document.querySelector("[data-code-snippet-highlight]")?.textContent === code,
        unicodeCode,
      );
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: "Wrap lines" }).click();
      const unicodeLayout = await readOverlayLayout(page);
      assert.equal(unicodeLayout.sourceText, unicodeCode);
      assert.equal(unicodeLayout.overlayText, unicodeCode);
      assert.ok(unicodeLayout.heightDelta <= 1 && unicodeLayout.widthDelta <= 1);
      assert.ok(unicodeLayout.maxCharacterDrift <= 1, JSON.stringify(unicodeLayout));
      assert.equal(
        await page
          .locator("[data-code-snippet]")
          .evaluate((element) => getComputedStyle(element).fontSize),
        "20px",
      );

      for (const [language, code] of [
        ["typescript", "// " + "x".repeat(20_001)],
        ["text", "plain <markup> & text"],
        ["unsupported-language", "unknown <markup> & text"],
      ]) {
        await page.evaluate(
          ({ language, code }) => {
            window.performanceChatCode.replaceMarkdown("```" + language + "\n" + code + "\n```");
          },
          { language, code },
        );
        await page.waitForFunction(
          (expected) =>
            document.querySelector("[data-code-snippet-source]")?.textContent === expected,
          code,
        );
        await page.evaluate(
          () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
        );
        assert.equal(await page.locator("[data-code-snippet-highlight]").count(), 0);
        assert.equal(await page.locator("[data-code-snippet-source]").textContent(), code);
      }

      await page.locator("#fixture-controls").hover();
      const finalWrapButton = page.getByRole("button", { name: "Wrap lines" }).first();
      await finalWrapButton.hover();
      await sharedHintAnchor.waitFor({ state: "attached" });
      await waitForSharedCodeHint(page, "Wrap lines");
      await page.evaluate(() => window.performanceChatCode.replaceMarkdown("plain paragraph"));
      await page.waitForFunction(() => !document.querySelector("[data-code-snippet]"));
      await waitForSharedCodeHintClosed(page);
      assert.equal(await sharedHintAnchor.count(), 0);

      await page.evaluate(() => {
        window.performanceChatCode.replaceMarkdown(
          "```mermaid\ngraph TD\n A[Start] --> B[Done]\n```",
        );
      });
      const renderedMermaidSvg = page.locator("[data-mermaid-block] svg");
      await renderedMermaidSvg.waitFor({ state: "attached", timeout: 30_000 });
      const mermaidPreviewButton = page.getByRole("button", {
        name: "Open preview",
        includeHidden: true,
      });
      await page.waitForFunction(() => {
        const button = Array.from(document.querySelectorAll("button")).find(
          (candidate) => candidate.getAttribute("aria-label") === "Open preview",
        );
        return Boolean(button && !button.disabled);
      });
      assert.equal(await mermaidPreviewButton.isEnabled(), true);
      await mermaidPreviewButton.hover();
      await sharedHintAnchor.waitFor({ state: "attached" });
      await waitForSharedCodeHint(page, "Open preview");
      assert.equal(await sharedHintAnchor.count(), 1);
      const mermaidHintId = await sharedHintTooltip.getAttribute("id");
      assert.ok(mermaidHintId);
      assert.ok(
        ((await mermaidPreviewButton.getAttribute("aria-describedby")) ?? "")
          .split(/\s+/)
          .includes(mermaidHintId),
      );

      await mermaidPreviewButton.click();
      const mermaidPreviewDialog = page.getByRole("dialog");
      await mermaidPreviewDialog.waitFor({ state: "visible" });
      const previewDiagramSvg = mermaidPreviewDialog.locator('[role="img"] svg');
      await previewDiagramSvg.waitFor({ state: "attached" });
      assert.equal(await previewDiagramSvg.count(), 1);
      // 预览 dialog 自动聚焦自己的缩放按钮，该按钮的独立提示允许存在；这里只断言正文共享提示已释放。
      await sharedHintAnchor.waitFor({ state: "detached" });
      assert.equal(await page.locator(`[id="${mermaidHintId}"]`).count(), 0);
      assert.equal(await mermaidPreviewButton.getAttribute("aria-describedby"), null);
      await mermaidPreviewDialog.hover({ position: { x: 20, y: 80 } });
      await mermaidPreviewDialog.focus();
      // Radix 提示退出期间仍占用最上层 Escape 处理；等待它卸载后验证 dialog 的 Escape。
      await page.getByRole("tooltip").waitFor({ state: "detached" });
      await page.keyboard.press("Escape");
      await mermaidPreviewDialog.waitFor({ state: "detached" });

      const noObserverPage = await context.newPage();
      noObserverPage.on("pageerror", (error) => pageErrors.push(error.message));
      await noObserverPage.addInitScript(() => {
        window.IntersectionObserver = undefined;
      });
      await noObserverPage.goto(new URL(`${fixturePath}?mode=static`, baseUrl).href, {
        waitUntil: "commit",
      });
      await waitForSnippets(noObserverPage);
      assert.equal(await noObserverPage.locator("[data-code-snippet-highlight]").count(), 0);
      assert.equal(await noObserverPage.locator("[data-code-snippet-source]").count(), 240);
      await noObserverPage.close();

      // 仅此页面用受控回调，直接验证过时输入、超 token 预算和卸载后的通知。
      const delayed = await context.newPage();
      delayed.on("pageerror", (error) => pageErrors.push(error.message));
      await delayed.route("**/packages/ui/src/lib/shikiHighlighter.ts*", async (route) => {
        await route.fulfill({
          contentType: "application/javascript",
          body: `export const shouldUseSyntaxHighlighting = (language) => language === "typescript";
            export function highlightCode(code, language, theme, callback) {
              (window.__delayedHighlights ??= []).push({ code, language, theme, callback });
              return null;
            }`,
        });
      });
      await delayed.goto(new URL(`${fixturePath}?mode=static`, baseUrl).href, {
        waitUntil: "commit",
      });
      await waitForSnippets(delayed);
      await delayed.evaluate(() => window.__releaseChatCodeVisibility());
      for (const code of ["const oldValue = 1;", "const currentValue = 2;"]) {
        await delayed.evaluate(
          (value) =>
            window.performanceChatCode.replaceMarkdown("```typescript\n" + value + "\n```"),
          code,
        );
        await delayed.waitForFunction(
          (value) => window.__delayedHighlights?.some((request) => request.code === value),
          code,
        );
      }
      await delayed.evaluate(() => {
        const request = window.__delayedHighlights.find((entry) => entry.code.includes("oldValue"));
        request.callback({ fg: "red", bg: "transparent", tokens: [[{ content: request.code }]] });
      });
      assert.equal(await delayed.locator("[data-code-snippet-highlight]").count(), 0);
      await delayed.evaluate(() => {
        const request = window.__delayedHighlights.find((entry) =>
          entry.code.includes("currentValue"),
        );
        request.callback({ fg: "blue", bg: "transparent", tokens: [[{ content: request.code }]] });
      });
      await delayed.locator("[data-code-snippet-highlight]").waitFor();
      assert.equal(
        await delayed.locator("[data-code-snippet-highlight]").textContent(),
        "const currentValue = 2;",
      );
      await delayed.evaluate(() =>
        window.performanceChatCode.replaceMarkdown("```typescript\nconst tooManyTokens = 3;\n```"),
      );
      await delayed.waitForFunction(() =>
        window.__delayedHighlights?.some((request) => request.code.includes("tooManyTokens")),
      );
      await delayed.evaluate(() => {
        const request = window.__delayedHighlights.find((entry) =>
          entry.code.includes("tooManyTokens"),
        );
        request.callback({
          fg: "red",
          bg: "transparent",
          tokens: [Array.from({ length: 10_001 }, () => ({ content: "" }))],
        });
      });
      assert.equal(await delayed.locator("[data-code-snippet-highlight]").count(), 0);
      await delayed.evaluate(() => window.performanceChatCode.replaceMarkdown("plain paragraph"));
      await delayed.waitForFunction(() => !document.querySelector("[data-code-snippet]"));
      await delayed.evaluate(() => {
        for (const request of window.__delayedHighlights) {
          request.callback({ fg: "red", bg: "transparent", tokens: [[{ content: request.code }]] });
        }
      });
      assert.equal(await delayed.locator("[data-code-snippet-highlight]").count(), 0);
      await delayed.close();

      const report = {
        payloadChars: 34_122,
        codeBlocks: 240,
        static: initial,
        history,
        streaming: { beforeComplete: streaming, afterComplete: afterCompletion },
        mountAndTransitionMeasures: afterCompletion.measures,
        blockedExternalRequests: blockedRequests,
      };
      console.log(`performance-chat-code ${JSON.stringify(report)}`);
      assert.deepEqual(blockedRequests, []);
      assert.deepEqual(pageErrors, []);
    } catch (error) {
      console.error(
        `performance-chat-code-failure ${JSON.stringify({ pageErrors, blockedRequests })}`,
      );
      throw error;
    } finally {
      try {
        await context?.close();
      } finally {
        try {
          await browser?.close();
        } finally {
          try {
            await server?.close();
          } finally {
            await rm(cacheDir, { recursive: true, force: true });
          }
        }
      }
    }
  },
);
