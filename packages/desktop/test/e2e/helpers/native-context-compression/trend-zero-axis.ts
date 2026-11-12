import assert from "node:assert/strict";
import { runNativeContextCleanup, withNativeContextCleanup } from "./cleanup.js";
import {
  getNativeContextStatus,
  listNativeContextObservations,
  nativeContextCurrentTarget,
} from "./queries.js";
import { nativeContextElement } from "./ui.js";

/** 只读实际 Recharts 3 SVG、选中详情与 tooltip，不按 CSS 尺寸推造刻度或图片用量。 */
export function readNativeContextZeroByteTrend() {
  const chart = document.querySelector('[data-testid="native-context-image-chart"]');
  const details = document.querySelector('[data-testid="native-context-request-details"]');
  const scroll = document.querySelector('[data-testid="native-context-detail-scroll"]');
  if (!chart || !details || !scroll) throw new Error("NCTX zero-byte trend surface is absent");
  const metric = (key: string) =>
    details
      .querySelector(`[data-testid="native-context-request-metric-${key}"] p.font-mono`)
      ?.textContent?.trim() ?? null;
  const tooltip = chart.querySelector<HTMLElement>(".recharts-tooltip-wrapper");
  return {
    requestCount: Number(chart.getAttribute("data-request-count")),
    scrollTop: scroll.scrollTop,
    unit: chart.querySelector(":scope > div:first-child > span")?.textContent?.trim() ?? null,
    ids: ["request-details", "input-chart", "cache-chart", "image-chart"].map(
      (id) =>
        document
          .querySelector(`[data-testid="native-context-${id}"]`)
          ?.getAttribute(
            id === "request-details" ? "data-observation-id" : "data-selected-observation-id",
          ) ?? null,
    ),
    yTicks: Array.from(
      chart.querySelectorAll(".recharts-yAxis-tick-labels text.recharts-cartesian-axis-tick-value"),
    ).map((tick) => ({
      label: tick.textContent?.trim() ?? "",
      y: Number(tick.getAttribute("y")),
    })),
    series: ["before", "after"].map((key) => {
      const path = chart.querySelector(
        `.native-context-series-${key}-own path.recharts-line-curve`,
      );
      return {
        key,
        vertices: Array.from(
          (path?.getAttribute("d") ?? "").matchAll(
            /[ML](-?\d+(?:\.\d+)?(?:e[+-]?\d+)?),(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/giu,
          ),
          (match) => ({ x: Number(match[1]), y: Number(match[2]) }),
        ),
      };
    }),
    dots: Array.from(chart.querySelectorAll("circle.recharts-line-dot")).map((dot) => ({
      x: Number(dot.getAttribute("cx")),
      y: Number(dot.getAttribute("cy")),
    })),
    sourceBytes: metric("sourceBytes"),
    sentBytes: metric("sentBytes"),
    tooltip: {
      visible: tooltip !== null && getComputedStyle(tooltip).visibility === "visible",
      label: tooltip?.querySelector(".font-medium")?.textContent?.trim() ?? null,
      values: tooltip
        ? Array.from(tooltip.querySelectorAll("span.font-mono")).map(
            (value) => value.textContent?.trim() ?? "",
          )
        : [],
    },
  };
}

/** 前置：早期 desktop 设置趋势已打开，当前范围全部是真实无图请求，图片单位为 bytes。 */
export async function assertNativeContextZeroByteAxis(locale: "zh-CN" | "en-US"): Promise<void> {
  const target = await nativeContextCurrentTarget();
  const before = await getNativeContextStatus(target);
  const page = await listNativeContextObservations(target, before, {
    purpose: "main",
    segmentId: before.currentSegmentId,
    limit: 200,
  });
  assert.equal(page.nextCursor, null, "NCTX zero-byte assertion requires the complete early range");
  assert.equal(page.revision, before.revision);
  assert.equal(page.generation, before.generation);
  assert.equal(page.historyVersion, before.historyVersion);
  const main = [...page.items].sort((left, right) => left.requestSeq - right.requestSeq);
  assert.ok(main.length >= 2, "NCTX zero-byte assertion requires the real early main request pair");
  for (const observation of main) {
    assert.equal(observation.origin, "own");
    assert.equal(observation.images.sourceCount, 0);
    assert.equal(observation.images.sourceCoverage, 0);
    assert.equal(observation.images.beforeBytes, 0);
    assert.equal(observation.images.afterBytes, 0);
  }
  await browser.waitUntil(
    async () => {
      const ui = await browser.execute(readNativeContextZeroByteTrend);
      return (
        ui.requestCount === main.length &&
        ui.yTicks.length >= 2 &&
        ui.series.every((series) => series.vertices.length > 0) &&
        ui.ids.every(Boolean)
      );
    },
    { timeout: 10000, timeoutMsg: "NCTX the actual zero-byte SVG did not finish rendering" },
  );
  const original = await browser.execute(readNativeContextZeroByteTrend);
  const selectedIndex = main.findIndex((observation) => observation.id === original.ids[0]);
  assert.ok(
    selectedIndex >= 0,
    "NCTX selected zero-byte observation must belong to the owner range",
  );
  const selected = main[selectedIndex]!;
  await withNativeContextCleanup(
    async () => {
      assert.equal(original.unit, "B");
      assert.ok(original.ids.every((id) => id === selected.id));
      const labels = original.yTicks.map((tick) => tick.label);
      // 原因：全零域曾生成分数 tick，整数 bytes 格式化后同轴重复 0 B/1 B；必须测实际 SVG 标签。
      assert.equal(
        new Set(labels).size,
        labels.length,
        `NCTX duplicate zero-byte Y ticks: ${labels.join(" | ")}`,
      );
      for (const label of labels) {
        assert.match(label, /^[\d,，]+\s+B$/u);
        assert.ok(Number.isInteger(Number(label.replace(/[,，\sB]/gu, ""))));
      }
      const zeroTick = original.yTicks.find((tick) => tick.label === "0 B");
      assert.ok(zeroTick, "NCTX real zero bytes must retain the zero tick");
      for (const series of original.series) {
        assert.ok(series.vertices.length >= main.length);
        assert.ok(series.vertices.every((vertex) => Math.abs(vertex.y - zeroTick.y) < 1));
      }
      assert.equal(original.dots.length, main.length * 2);
      assert.equal(original.sourceBytes, "0 B");
      assert.equal(original.sentBytes, "0 B");
      const vertex = original.series.find((series) => series.key === "after")?.vertices[
        selectedIndex
      ];
      assert.ok(vertex);
      // Recharts 3 的 dots 位于 portal，不在系列 class 子树；用真实 SVG 顶点关联对应请求圆点。
      const dotIndex = original.dots.findIndex(
        (dot) => Math.abs(dot.x - vertex.x) < 0.01 && Math.abs(dot.y - vertex.y) < 0.01,
      );
      assert.ok(dotIndex >= 0);
      const dots = await nativeContextElement("image-chart").$$("circle.recharts-line-dot");
      const dot = dots[dotIndex];
      assert.ok(dot, "NCTX the selected owner's real zero-byte SVG dot is missing");
      await dot.scrollIntoView({ block: "center", inline: "nearest" });
      await dot.moveTo();
      const expectedLabel =
        locale === "zh-CN" ? `第 ${selected.requestSeq} 次请求` : `Request ${selected.requestSeq}`;
      let hovered = original;
      await browser.waitUntil(
        async () => {
          hovered = await browser.execute(readNativeContextZeroByteTrend);
          return hovered.tooltip.visible && hovered.tooltip.label === expectedLabel;
        },
        {
          timeout: 10000,
          timeoutMsg: "NCTX the zero-byte tooltip did not identify the selected owner request",
        },
      );
      assert.deepEqual(hovered.tooltip.values, ["0 B", "0 B"]);
      assert.equal(hovered.sourceBytes, "0 B");
      assert.equal(hovered.sentBytes, "0 B");
      assert.ok(hovered.ids.every((id) => id === selected.id));
      const after = await getNativeContextStatus(target);
      assert.equal(after.revision, before.revision);
      assert.equal(after.generation, before.generation);
      assert.equal(after.historyVersion, before.historyVersion);
    },
    () =>
      runNativeContextCleanup(
        async () => {
          await nativeContextElement("tab-trends").moveTo();
        },
        async () => {
          await browser.execute((top) => {
            document
              .querySelector('[data-testid="native-context-detail-scroll"]')
              ?.scrollTo({ top, behavior: "instant" });
          }, original.scrollTop);
        },
      ),
  );
}
