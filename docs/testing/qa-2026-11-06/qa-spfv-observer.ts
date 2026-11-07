import { open, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

let observationCounter = 0;

interface ObservationContext {
  artifacts: string;
  observerSourceSha256: string;
  hookSourceSha256: string;
}

/** 只读记录正式 SPFV002 终态；不能用观察器改变原测试的布局或断言。 */
export async function observeSpfv002(context: Mocha.Context, paths: ObservationContext) {
  const test = context.currentTest;
  const canonicalSuffix = "/packages/desktop/test/e2e/ui-shell/side-pane-full-view.test.ts";
  if (!test?.title.startsWith("SPFV-E2E-002 ") || !test.file?.replaceAll("\\", "/").endsWith(canonicalSuffix)) return;
  const artifacts = resolve(paths.artifacts);
  const worker = (process.env.WDIO_WORKER_ID || String(process.pid)).replace(/[^a-zA-Z0-9_-]/gu, "_");
  const counter = ++observationCounter;
  const stem = join(artifacts, `qa-spfv-observe-${worker}-${String(counter).padStart(3, "0")}-${process.pid}-${Date.now()}`);
  const capturedAt = new Date().toISOString();
  const evidence: Record<string, unknown> = {
    evidenceKind: "read-only actual SPFV-E2E-002 afterEach DOM and PNG; synthetic E2E only",
    capturedAt,
    worker,
    counter,
    test: { title: test.title, file: test.file, state: test.state, assertionError: test.err?.message ?? null },
    ...paths,
  };
  try {
    // tsx 的 keepNames 会给嵌套函数注入闭包 helper；远端 execute 无该绑定，改传纯 JS 源码。
    evidence.dom = await browser.execute(String.raw`return (() => {
      const hostSelector = '[data-testid="side-pane-full-view-host"]';
      const host = document.querySelector(hostSelector);
      const inspect = (element) => {
        if (!element) return null;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const html = element instanceof HTMLElement ? element : null;
        return {
          tag: element.tagName,
          testId: element.getAttribute("data-testid"),
          role: element.getAttribute("role"),
          className: element.getAttribute("class"),
          dataset: html ? { ...html.dataset } : null,
          rect: rect.toJSON(),
          computed: {
            display: style.display, position: style.position, opacity: style.opacity,
            visibility: style.visibility, fontFamily: style.fontFamily, fontSize: style.fontSize,
            fontWeight: style.fontWeight, lineHeight: style.lineHeight,
            padding: style.padding, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom,
            paddingLeft: style.paddingLeft, paddingRight: style.paddingRight,
            margin: style.margin, borderWidth: style.borderWidth, boxSizing: style.boxSizing,
            width: style.width, height: style.height, minWidth: style.minWidth, minHeight: style.minHeight,
            maxWidth: style.maxWidth, maxHeight: style.maxHeight, flex: style.flex,
            flexDirection: style.flexDirection, flexWrap: style.flexWrap,
            alignItems: style.alignItems, alignSelf: style.alignSelf, justifyContent: style.justifyContent,
            gap: style.gap, rowGap: style.rowGap, columnGap: style.columnGap,
            whiteSpace: style.whiteSpace, overflow: style.overflow, transform: style.transform,
          },
          scroll: html ? { width: html.scrollWidth, height: html.scrollHeight, clientWidth: html.clientWidth, clientHeight: html.clientHeight } : null,
        };
      };
      const local = (selector) => inspect(host?.querySelector(selector) ?? null);
      const all = (selector) => Array.from(document.querySelectorAll(selector)).map(inspect);
      const toolbars = Array.from(document.querySelectorAll(".group\\/toolbar"));
      return {
        dpr: window.devicePixelRatio,
        viewport: { width: window.innerWidth, height: window.innerHeight, outerWidth: window.outerWidth, outerHeight: window.outerHeight, scale: window.visualViewport?.scale ?? null },
        activeElement: inspect(document.activeElement),
        host: inspect(host),
        slot: inspect(document.querySelector('[data-workspace-side-frame="true"] [data-side-pane-content-slot]')),
        dock: local('[data-v4-composer-dock="true"]'),
        dockContent: local('[data-v4-composer-dock-content="true"]'),
        editor: local('[data-testid="v4-composer-input"]'),
        editorParent: inspect(host?.querySelector('[data-testid="v4-composer-input"]')?.parentElement ?? null),
        shell: local("[data-composer-layout]"),
        action: local("[data-composer-action-menu] button"),
        send: local('[data-testid="v4-composer-send"]'),
        model: local('[data-testid="chat-model-select-trigger"]'),
        leadingActions: local("[data-composer-leading-actions]"),
        trailingActions: local("[data-composer-trailing-actions]"),
        layouts: all("[data-composer-layout]"),
        toolbars: toolbars.map((toolbar) => ({
          ...inspect(toolbar),
          withinObservedHost: Boolean(host?.contains(toolbar)),
          modelTextSpans: Array.from(toolbar.querySelectorAll('[data-testid="chat-model-select-trigger"] span')).map((span) => ({...inspect(span), text: span.textContent?.trim() ?? ""})),
          descendants: Array.from(toolbar.querySelectorAll("button,[data-composer-leading-content],[data-composer-trailing-actions]")).map(inspect),
        })),
        finiteAnimations: host?.getAnimations({subtree: true}).map((animation) => ({playState: animation.playState, currentTime: animation.currentTime, endTime: animation.effect?.getComputedTiming().endTime ?? null})) ?? [],
      };
    })();`);
    const screenshot = stem + ".png";
    const reservation = await open(screenshot, "wx");
    await reservation.close();
    await browser.saveScreenshot(screenshot);
    evidence.screenshot = screenshot;
  } catch (error) {
    evidence.observationError = error instanceof Error ? error.message : String(error);
    await writeFile(stem + ".json", JSON.stringify(evidence, null, 2) + "\n", {flag: "wx"});
    throw error;
  }
  await writeFile(stem + ".json", JSON.stringify(evidence, null, 2) + "\n", {flag: "wx"});
}
