import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright-core";
import {
  restoreElectronRendererContentSize,
  setCurrentElectronRendererContentSize,
} from "../desktop-app.js";
import { assertNativeContextTestPath } from "./environment.js";
import {
  getNativeContextStatus,
  listNativeContextObservations,
  nativeContextCurrentTarget,
} from "./queries.js";
import { nativeContextElement, openNativeContextDetails } from "./ui.js";
import { closeNativeContextMobileDetails } from "./mobile.js";
import { runNativeContextCleanup, withNativeContextCleanup } from "./cleanup.js";

function readTrendGeometry() {
  const dialog = document.querySelector<HTMLElement>('[data-testid="native-context-details"]');
  const scroll = dialog?.querySelector<HTMLElement>('[data-testid="native-context-detail-scroll"]');
  if (!dialog || !scroll) throw new Error("NCTX context dialog layout is unavailable");
  const chartIds = ["input-chart", "cache-chart", "image-chart"];
  const chartElements = chartIds.map((id) => {
    const element = dialog.querySelector<HTMLElement>(`[data-testid="native-context-${id}"]`);
    if (!element) throw new Error("NCTX a trend chart is missing");
    return element;
  });
  const tabElements = Array.from(dialog.querySelectorAll('[role="tablist"] [role="tab"]'));
  const close = dialog.querySelector('[data-slot="dialog-close"]');
  if (!close) throw new Error("NCTX dialog close action is missing");
  // 原因：命名的局部函数会被 keepNames 注入模块 __name；独立页面函数只使用匿名回调。
  const bounds = [dialog, close, ...tabElements, ...chartElements].map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      right: rect.right,
      bottom: rect.bottom,
    };
  });
  const charts = chartElements.map((element, index) => ({
    ...bounds[2 + tabElements.length + index]!,
    ticks: element.querySelectorAll(
      ".recharts-xAxis-tick-labels text.recharts-cartesian-axis-tick-value",
    ).length,
  }));
  const animationPending = dialog.getAnimations({ subtree: true }).some((animation) => {
    const timing = animation.effect?.getComputedTiming();
    return animation.playState === "running" && timing?.iterations !== Infinity;
  });
  return {
    viewport: { width: innerWidth, height: innerHeight },
    dialog: bounds[0]!,
    close: bounds[1]!,
    tabs: bounds.slice(2, 2 + tabElements.length),
    charts,
    scroll: { width: scroll.clientWidth, content: scroll.scrollWidth },
    animationPending,
  };
}

function assertTrendGeometry(geometry: ReturnType<typeof readTrendGeometry>, width: number) {
  expect(Math.abs(geometry.viewport.width - width)).toBeLessThanOrEqual(1);
  expect(geometry.dialog.x).toBeGreaterThanOrEqual(0);
  expect(geometry.dialog.right).toBeLessThanOrEqual(width + 1);
  expect(geometry.dialog.bottom).toBeLessThanOrEqual(geometry.viewport.height + 1);
  expect(geometry.scroll.content).toBeLessThanOrEqual(geometry.scroll.width + 1);
  expect(geometry.tabs).toHaveLength(4);
  for (const tab of geometry.tabs) {
    expect(Math.abs(tab.width - geometry.tabs[0]!.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(tab.y - geometry.tabs[0]!.y)).toBeLessThanOrEqual(1);
    expect(tab.height).toBeGreaterThanOrEqual(44);
  }
  expect(geometry.close.right).toBeLessThanOrEqual(width);
  expect(geometry.close.y).toBeGreaterThanOrEqual(0);
  for (const chart of geometry.charts) {
    expect(chart.width).toBeGreaterThan(150);
    expect(chart.ticks).toBeGreaterThan(0);
    expect(chart.ticks).toBeLessThanOrEqual(4);
  }
  const [, cache, image] = geometry.charts;
  if (width >= 768) {
    expect(Math.abs(cache!.y - image!.y)).toBeLessThanOrEqual(1);
    expect(image!.x).toBeGreaterThanOrEqual(cache!.right);
  } else {
    expect(Math.abs(cache!.x - image!.x)).toBeLessThanOrEqual(1);
    expect(image!.y).toBeGreaterThanOrEqual(cache!.bottom);
  }
}

export async function assertNativeContextTrendLayout(width: number, evidenceDirectory?: string) {
  const original = await setCurrentElectronRendererContentSize(1024, 850);
  const minimum = await browser.electron.execute((electron, id) => {
    const owner = electron.BrowserWindow.fromId(id)!;
    const current = owner.getMinimumSize();
    owner.setMinimumSize(320, 400);
    return current;
  }, original.windowId);
  try {
    await setCurrentElectronRendererContentSize(width, 850);
    await openNativeContextDetails("trends");
    await nativeContextElement("input-chart").waitForDisplayed();
    await browser.waitUntil(
      async () => !(await browser.execute(readTrendGeometry)).animationPending,
      {
        timeout: 10000,
        timeoutMsg: "NCTX context dialog animation did not settle after resizing",
      },
    );
    assertTrendGeometry(await browser.execute(readTrendGeometry), width);
    if (evidenceDirectory) {
      await browser.saveScreenshot(
        await assertNativeContextTestPath(
          join(evidenceDirectory, `native-context-desktop-${width}.png`),
        ),
      );
    }
  } finally {
    await browser.electron.execute(
      (electron, id, size) => {
        electron.BrowserWindow.fromId(id)?.setMinimumSize(size[0]!, size[1]!);
      },
      original.windowId,
      minimum,
    );
    await restoreElectronRendererContentSize(original);
  }
}

async function waitMobileSelection(page: Page, observationId: string) {
  await page.waitForFunction(
    (id) => {
      const chartIds = ["input-chart", "cache-chart", "image-chart"];
      return (
        document
          .querySelector('[data-testid="native-context-request-details"]')
          ?.getAttribute("data-observation-id") === id &&
        chartIds.every(
          (chart) =>
            document
              .querySelector(`[data-testid="native-context-${chart}"]`)
              ?.getAttribute("data-selected-observation-id") === id,
        )
      );
    },
    observationId,
    { timeout: 10000 },
  );
}

export async function assertNativeContextMobileLayout(
  page: Page,
  width: number,
  evidenceDirectory?: string,
) {
  const original = page.viewportSize();
  const target = await nativeContextCurrentTarget();
  const status = await getNativeContextStatus(target);
  const catalog = await listNativeContextObservations(target, status, {
    purpose: "main",
    limit: 200,
  });
  const main = [...catalog.items].sort(
    (left, right) => left.requestSeq - right.requestSeq || left.attemptIndex - right.attemptIndex,
  );
  const current = main.filter((entry) => entry.segmentId === status.currentSegmentId).slice(-200);
  expect(current.length).toBeGreaterThan(1);
  await withNativeContextCleanup(
    async () => {
      await page.setViewportSize({ width, height: 900 });
      const element = (id: string) => page.getByTestId("native-context-" + id);
      if (!(await element("details").isVisible())) {
        if (!(await element("popover").isVisible())) await element("entry").tap();
        await element("open-trends").tap();
      }
      await element("tab-trends").tap();
      await element("trend-segment").tap();
      await page.getByRole("option").nth(0).tap();
      await element("trend-range").tap();
      await page.getByRole("option").nth(1).tap();
      await element("input-chart").waitFor({ state: "visible", timeout: 20000 });
      await page.waitForFunction(
        (count) => {
          const ids = ["input-chart", "cache-chart", "image-chart"];
          return ids.every(
            (id) =>
              Number(
                document
                  .querySelector(`[data-testid="native-context-${id}"]`)
                  ?.getAttribute("data-request-count"),
              ) === count,
          );
        },
        current.length,
        { timeout: 20000 },
      );
      await page.waitForFunction(
        () => {
          const dialog = document.querySelector('[data-testid="native-context-details"]');
          return (
            !!dialog &&
            dialog
              .getAnimations({ subtree: true })
              .every(
                (animation) =>
                  animation.playState !== "running" ||
                  animation.effect?.getComputedTiming().iterations === Infinity,
              )
          );
        },
        undefined,
        { timeout: 10000 },
      );
      assertTrendGeometry(await page.evaluate(readTrendGeometry), width);

      const keys = element("input-chart").locator('[role="group"][tabindex="0"]');
      await keys.focus();
      await keys.press("Home");
      await waitMobileSelection(page, current[0]!.id);
      await keys.press("ArrowRight");
      await waitMobileSelection(page, current[1]!.id);
      await keys.press("End");
      await waitMobileSelection(page, current.at(-1)!.id);
      await element("input-chart").scrollIntoViewIfNeeded();
      // 原因：第一条估算曲线可能被后绘制曲线遮住；按真实命中点触摸不同于 End 的请求。
      const touch = await element("input-chart").evaluate((chart) => {
        const ticks = chart.querySelectorAll(
          ".recharts-xAxis-tick-labels text.recharts-cartesian-axis-tick-value",
        );
        if (ticks.length < 2) throw new Error("NCTX real touch chart axes are unavailable");
        const first = Number(ticks[0]!.getAttribute("x"));
        const last = Number(ticks[ticks.length - 1]!.getAttribute("x"));
        const count = Number(chart.getAttribute("data-request-count"));
        const candidates = Array.from(chart.querySelectorAll(".recharts-line-dots circle")).map(
          (dot, ordinal) => {
            const cx = Number(dot.getAttribute("cx"));
            const cy = Number(dot.getAttribute("cy"));
            const rect = dot.getBoundingClientRect();
            const x = rect.x + rect.width / 2;
            const y = rect.y + rect.height / 2;
            const position = ((cx - first) / (last - first)) * (count - 1);
            const index = Math.round(position);
            const finite = [cx, cy, x, y, position].every(Number.isFinite);
            return {
              ordinal,
              index,
              cx,
              cy,
              hit:
                finite &&
                rect.width > 0 &&
                rect.height > 0 &&
                x >= 0 &&
                x <= innerWidth &&
                y >= 0 &&
                y <= innerHeight &&
                document.elementFromPoint(x, y) === dot,
              originalPoint: finite && Math.abs(position - index) < 0.01,
            };
          },
        );
        const candidate = [...candidates]
          .reverse()
          .find(
            (point) =>
              point.hit && point.originalPoint && point.index >= 0 && point.index < count - 1,
          );
        return { count, candidate: candidate ?? null, candidates: candidates.slice(-16) };
      });
      expect(touch.count).toBe(current.length);
      if (!touch.candidate)
        throw new Error("NCTX no exposed non-End touch point: " + JSON.stringify(touch));
      const selected = current[touch.candidate.index]!.id;
      expect(selected).not.toBe(current.at(-1)!.id);
      await element("input-chart")
        .locator(".recharts-line-dots circle")
        .nth(touch.candidate.ordinal)
        .tap();
      await waitMobileSelection(page, selected);
      await element("tab-parameters").tap();
      await element("budget-preview").waitFor({ state: "visible" });
      expect(await element("save-parameters").isVisible()).toBe(true);
      await element("tab-records").tap();
      await element("records").waitFor({ state: "visible" });
      await element("tab-trends").tap();
      await waitMobileSelection(page, selected);
      if (evidenceDirectory) {
        const selection = await page.evaluate(
          (ids) => {
            const charts = ["input-chart", "cache-chart", "image-chart"].map((id) =>
              document.querySelector(`[data-testid="native-context-${id}"]`),
            );
            const selected = [
              document
                .querySelector('[data-testid="native-context-request-details"]')
                ?.getAttribute("data-observation-id"),
              ...charts.map((chart) => chart?.getAttribute("data-selected-observation-id")),
            ];
            return {
              indices: selected.map((id) => ids.indexOf(id ?? "")),
              counts: charts.map((chart) => Number(chart?.getAttribute("data-request-count"))),
            };
          },
          current.map((entry) => entry.id),
        );
        // 原因：截图不能证明触摸选中了另一个请求；只保存原始索引与四处选择的数字对账。
        await writeFile(
          await assertNativeContextTestPath(
            join(evidenceDirectory, `native-context-mobile-touch-${width}.json`),
          ),
          JSON.stringify(
            {
              width,
              requestCount: touch.count,
              previousIndex: current.length - 1,
              touchedIndex: touch.candidate.index,
              touchedOrdinal: touch.candidate.ordinal,
              selection,
              returnedToTrends: true,
            },
            null,
            2,
          ),
        );
        await page.screenshot({
          path: await assertNativeContextTestPath(
            join(evidenceDirectory, `native-context-mobile-${width}.png`),
          ),
        });
      }
    },
    async () => {
      // 原因：读取图表失败也必须关闭真实详情；残留模态层会让下一场无法命中 Home 返回按钮。
      await runNativeContextCleanup(
        () => closeNativeContextMobileDetails(page),
        async () => {
          if (original) await page.setViewportSize(original);
        },
      );
    },
  );
}
