import assert from "node:assert/strict";
import type { NativeContextLedgerManifest } from "./ledger-fixture-contract.js";

/** 同一个只读 DOM 探针可在现有 desktop browser 或现有 mobile Page 上执行。 */
export function readNativeContextLargeLedgerSvg(input: { chartId: string; series: string }) {
  const chart = document.querySelector(`[data-testid="native-context-${input.chartId}"]`);
  if (!chart) throw new Error("NCTX-58 rendered chart is absent");
  const path = chart.querySelector<SVGPathElement>(
    `.native-context-series-${input.series}-own path.recharts-line-curve`,
  );
  if (!path) throw new Error("NCTX-58 rendered line is absent");
  // 原因：局部命名 axes 会依赖测试模块 __name；匿名回调的只读探针可独立序列化到手机。
  const axes = ["x", "y"].map((axis) =>
    // Recharts 3 将轴标签独立放在 portal 图层，不能从刻度线分组查找文字。
    Array.from(
      chart.querySelectorAll(
        `.recharts-${axis}Axis-tick-labels text.recharts-cartesian-axis-tick-value`,
      ),
    )
      .map((tick) => ({
        position: Number(tick.getAttribute(axis === "x" ? "x" : "y")),
        value: Number((tick.textContent ?? "").replace(/[#,%，\s]/gu, "")),
      }))
      .filter((tick) => Number.isFinite(tick.value) && Number.isFinite(tick.position)),
  );
  const segments = (path.getAttribute("d")?.match(/M[^M]*/gu) ?? []).map((segment) =>
    [...segment.matchAll(/[ML](-?[\d.]+(?:e[+-]?\d+)?),(-?[\d.]+(?:e[+-]?\d+)?)/giu)].map(
      (match) => ({ x: Number(match[1]), y: Number(match[2]) }),
    ),
  );
  const actualPath = chart.querySelector<SVGPathElement>(
    ".native-context-series-actual-own path.recharts-line-curve",
  );
  // Recharts 3 将圆点放在独立 portal；以真实 own 曲线的绘制属性区分系列及继承来源。
  // 保留全部匹配圆点，不能按已知顶点过滤，否则未知区间的误点会被测试遗漏。
  const drawingAttributes = ["stroke", "stroke-width", "stroke-opacity", "stroke-dasharray"];
  const actualDots = actualPath?.getAttribute("stroke")
    ? Array.from(chart.querySelectorAll("circle.recharts-line-dot")).filter((dot) =>
        drawingAttributes.every(
          (attribute) => dot.getAttribute(attribute) === actualPath.getAttribute(attribute),
        ),
      )
    : [];
  return {
    chartId: input.chartId,
    requestCount: Number(chart.getAttribute("data-request-count")),
    selectedId: chart.getAttribute("data-selected-observation-id"),
    xAxis: axes[0]!,
    yAxis: axes[1]!,
    segments,
    length: path.getTotalLength(),
    width: path.getBBox().width,
    actualDots: actualDots.map((dot) => ({
      x: Number(dot.getAttribute("cx")),
      y: Number(dot.getAttribute("cy")),
    })),
    eventXs: Array.from(
      chart.querySelectorAll('line.recharts-reference-line-line[stroke-dasharray="1 4"]'),
    ).map((line) => Number(line.getAttribute("x1"))),
    selectedXs: Array.from(
      chart.querySelectorAll('line.recharts-reference-line-line[stroke-dasharray="4 4"]'),
    ).map((line) => Number(line.getAttribute("x1"))),
  };
}

export type NativeContextLedgerSvg = ReturnType<typeof readNativeContextLargeLedgerSvg>;
const near = (left: number, right: number) => Math.abs(left - right) < 0.2;
function coordinate(axis: NativeContextLedgerSvg["xAxis"], value: number) {
  const first = axis[0]!;
  const last = axis.at(-1)!;
  assert.ok(
    axis.length >= 2 && first.value !== last.value,
    "NCTX-58 real SVG axis must be measurable",
  );
  return (
    first.position +
    ((value - first.value) * (last.position - first.position)) / (last.value - first.value)
  );
}

export function assertNativeContextLargeLedgerSvg(
  manifest: NativeContextLedgerManifest,
  input: NativeContextLedgerSvg,
  cache: NativeContextLedgerSvg,
) {
  for (const chart of [input, cache]) {
    assert.equal(chart.requestCount, manifest.counts.main);
    assert.ok(chart.length > 0 && chart.width > 0);
  }
  const drawn = input.segments.flat();
  assert.ok(
    drawn.length > 0 && drawn.length < manifest.counts.main,
    "NCTX-58 must measure actual aggregated SVG drawing, not just its request count",
  );
  for (const key of ["first", "last", "peak", "zero"] as const) {
    const point = manifest.sentinels[key];
    const x = coordinate(input.xAxis, point.requestSeq);
    const y = coordinate(input.yAxis, point.afterEstimate!);
    assert.ok(
      drawn.some((dot) => near(dot.x, x) && near(dot.y, y)),
      `NCTX-58 SVG lost ${key}`,
    );
  }
  for (const key of ["peak", "zero"] as const) {
    const point = manifest.sentinels[key];
    assert.ok(
      input.actualDots.some(
        (dot) =>
          near(dot.x, coordinate(input.xAxis, point.requestSeq)) &&
          near(dot.y, coordinate(input.yAxis, point.actualInputTokens!)),
      ),
      `NCTX-58 actual point lost ${key}`,
    );
  }
  for (const gap of manifest.unknownGaps) {
    const left = coordinate(cache.xAxis, gap.first - 1);
    const right = coordinate(cache.xAxis, gap.last + 1);
    assert.ok(cache.segments.some((segment) => segment.some((dot) => near(dot.x, left))));
    assert.ok(cache.segments.some((segment) => segment.some((dot) => near(dot.x, right))));
    assert.ok(
      !cache.segments.some(
        (segment) => segment[0]!.x <= left + 0.1 && segment.at(-1)!.x >= right - 0.1,
      ),
      "NCTX-58 SVG connected across an unknown cache interval",
    );
    const firstUnknown = coordinate(input.xAxis, gap.first);
    const lastUnknown = coordinate(input.xAxis, gap.last);
    assert.ok(
      !input.actualDots.some((dot) => dot.x >= firstUnknown - 0.01 && dot.x <= lastUnknown + 0.01),
      "NCTX-58 actual input unknown was rendered as a real dot",
    );
  }
  for (const operation of manifest.operations.filter((record) => record.status === "completed")) {
    const x = coordinate(input.xAxis, operation.anchorRequestSeq! + 1);
    assert.ok(
      input.eventXs.some((eventX) => near(eventX, x)),
      "NCTX-58 SVG lost an old maintenance event",
    );
  }
  return {
    loaded: input.requestCount,
    drawn: drawn.length,
    cacheSegments: cache.segments.length,
    events: input.eventXs.length,
  };
}

export function assertNativeContextLargeLedgerSelectedSvg(
  manifest: NativeContextLedgerManifest,
  snapshot: NativeContextLedgerSvg,
) {
  const original = manifest.sentinels.selected;
  assert.equal(snapshot.selectedId, original.id);
  const x = coordinate(snapshot.xAxis, original.requestSeq);
  const y = coordinate(snapshot.yAxis, original.afterEstimate!);
  assert.ok(
    snapshot.segments.flat().some((point) => near(point.x, x) && near(point.y, y)),
    "NCTX-58 selected original point must be retained by actual SVG aggregation",
  );
  assert.ok(snapshot.selectedXs.some((selectedX) => near(selectedX, x)));
}
