import {
  nativeContextCacheHitPercent,
  type NativeContextObservation,
} from "@zcode/shared/native-context-compression";
import { getUpstreamRequestRecordCount } from "../conversation-session-network.js";
import {
  getNativeContextStatus,
  listNativeContextObservations,
  nativeContextCurrentTarget,
  readNativeContextRecord,
} from "./queries.js";
import {
  chooseNativeContextOption,
  closeNativeContextDetails,
  nativeContextElement,
  openNativeContextDetails,
} from "./ui.js";

export { assertNativeContextTrendLayout, assertNativeContextMobileLayout } from "./trend-layout.js";

const CHARTS = ["input-chart", "cache-chart", "image-chart"] as const;
type TrendChartId = (typeof CHARTS)[number];

function comparableRequest(left: NativeContextObservation, right: NativeContextObservation) {
  return (
    left.generation === right.generation &&
    left.segmentId === right.segmentId &&
    left.model.providerId === right.model.providerId &&
    left.model.modelId === right.model.modelId &&
    left.contextWindow === right.contextWindow &&
    left.inputBudget === right.inputBudget &&
    left.estimatorVersion === right.estimatorVersion &&
    left.origin === right.origin
  );
}

function readSvgSeries(chartId: string, series: string) {
  const chart = document.querySelector(`[data-testid="native-context-${chartId}"]`);
  if (!chart) throw new Error("NCTX real SVG chart is missing");
  const ticks = Array.from(
    // Recharts 3 的刻度文字通过 portal 独立渲染；tickLine=false 时旧轴组没有文字。
    chart.querySelectorAll(".recharts-xAxis-tick-labels text.recharts-cartesian-axis-tick-value"),
  ).map((tick) => Number(tick.getAttribute("x")));
  const path = chart.querySelector<SVGPathElement>(
    `.native-context-series-${series}-own path.recharts-line-curve`,
  );
  if (!path || ticks.length < 2) throw new Error("NCTX real SVG line or axis is missing");
  const d = path.getAttribute("d") ?? "";
  return {
    d,
    length: path.getTotalLength(),
    width: path.getBBox().width,
    opacity: Number(path.getAttribute("stroke-opacity") ?? "1"),
    minX: Math.min(...ticks),
    maxX: Math.max(...ticks),
    segments: (d.match(/M[^M]*/gu) ?? []).map((segment) => {
      const coordinates = [...segment.matchAll(/[ML](-?[\d.]+(?:e[+-]?\d+)?),/giu)].map((match) =>
        Number(match[1]),
      );
      return {
        firstX: coordinates[0]!,
        lastX: coordinates.at(-1)!,
        points: coordinates.length,
      };
    }),
  };
}

async function expectRealTrendLines(main: readonly NativeContextObservation[]) {
  const afterSeries = nativeContextElement("input-chart-series-after");
  if ((await afterSeries.getAttribute("aria-pressed")) === "false") await afterSeries.click();
  const runs: number[][] = [];
  for (let index = 0; index < main.length; index += 1) {
    const observation = main[index]!;
    if (observation.origin !== "own" || observation.afterEstimate === null) continue;
    const run = runs.at(-1);
    const previousIndex = run?.at(-1);
    if (previousIndex === index - 1 && comparableRequest(main[previousIndex]!, observation))
      run!.push(index);
    else runs.push([index]);
  }
  const continuous = runs.find(
    (run) => run.length >= 3 && new Set(run.map((index) => main[index]!.historyVersion)).size > 1,
  );
  expect(continuous).toBeDefined();
  const input = await browser.execute(readSvgSeries, "input-chart", "after");
  expect(input.length).toBeGreaterThan(0);
  expect(input.width).toBeGreaterThan(0);
  expect(input.opacity).toBeGreaterThan(0);
  const xAt = (index: number) =>
    input.minX + ((input.maxX - input.minX) * index) / (main.length - 1);
  const contains = (segment: { firstX: number; lastX: number }, first: number, last: number) =>
    segment.firstX <= xAt(first) + 0.1 && segment.lastX >= xAt(last) - 0.1;
  // 原因：请求数和圆点会掩盖每次 historyVersion 变化都断线；必须检查真实 SVG 子路径。
  expect(
    input.segments.some(
      (segment) => segment.points >= 3 && contains(segment, continuous![0]!, continuous!.at(-1)!),
    ),
  ).toBe(true);
  for (let index = 1; index < main.length; index += 1) {
    const left = main[index - 1]!;
    const right = main[index]!;
    if (
      left.origin === "own" &&
      right.origin === "own" &&
      left.afterEstimate !== null &&
      right.afterEstimate !== null &&
      !comparableRequest(left, right)
    )
      expect(input.segments.some((segment) => contains(segment, index - 1, index))).toBe(false);
  }

  const hits = main.map(nativeContextCacheHitPercent);
  const gap = main.findIndex((left, index) => {
    if (left.origin !== "own" || hits[index] === null || hits[index + 1] !== null) return false;
    const right = hits.findIndex((value, next) => next > index + 1 && value !== null);
    return right > index && comparableRequest(left, main[right]!);
  });
  expect(gap).toBeGreaterThanOrEqual(0);
  const right = hits.findIndex((value, index) => index > gap + 1 && value !== null);
  const cache = await browser.execute(readSvgSeries, "cache-chart", "hit");
  const cacheX = (index: number) =>
    cache.minX + ((cache.maxX - cache.minX) * index) / (main.length - 1);
  const segmentAt = (index: number) =>
    cache.segments.findIndex(
      (segment) => segment.firstX <= cacheX(index) + 0.1 && segment.lastX >= cacheX(index) - 0.1,
    );
  expect(segmentAt(gap)).toBeGreaterThanOrEqual(0);
  expect(segmentAt(right)).toBeGreaterThanOrEqual(0);
  expect(segmentAt(gap)).not.toBe(segmentAt(right));
}

async function waitForTrendCount(count: number) {
  await browser.waitUntil(
    async () => {
      for (const chart of CHARTS) {
        if (Number(await nativeContextElement(chart).getAttribute("data-request-count")) !== count)
          return false;
      }
      return true;
    },
    {
      timeout: 20000,
      timeoutMsg: "NCTX three charts did not share the expected main request range",
    },
  );
}

function readTrendSelection(chart?: TrendChartId) {
  const dialog = document.querySelector('[data-testid="native-context-details"]');
  const group = chart
    ? dialog?.querySelector(`[data-testid="native-context-${chart}"] [role="group"][tabindex="0"]`)
    : null;
  const active = document.activeElement;
  return {
    ids: ["request-details", "input-chart", "cache-chart", "image-chart"].map((testId) => ({
      testId,
      id:
        dialog
          ?.querySelector(`[data-testid="native-context-${testId}"]`)
          ?.getAttribute(
            testId === "request-details" ? "data-observation-id" : "data-selected-observation-id",
          ) ?? null,
    })),
    groupPresent: Boolean(group),
    activeElement: {
      tagName: active?.tagName ?? null,
      testId: active?.getAttribute("data-testid") ?? null,
      role: active?.getAttribute("role") ?? null,
      inDialog: dialog?.contains(active) ?? false,
      inTargetGroup: group?.contains(active) ?? false,
    },
  };
}

async function focusTrendKeyboardGroup(
  chart: TrendChartId,
  direction: "Tab" | "Shift+Tab" = "Tab",
) {
  let snapshot: ReturnType<typeof readTrendSelection> | undefined;
  // 原因：容器 click 不能证明键盘焦点已转移；真实 Tab 遍历到本图 group/SVG 子树后才发送选点键。
  for (let step = 0; step < 80; step += 1) {
    snapshot = await browser.execute(readTrendSelection, chart);
    if (!snapshot.groupPresent || !snapshot.activeElement.inDialog)
      throw new Error(
        `NCTX chart keyboard target is unavailable: ${chart}; ${JSON.stringify(snapshot)}`,
      );
    if (snapshot.activeElement.inTargetGroup) return;
    await browser.keys(direction === "Shift+Tab" ? ["Shift", "Tab"] : direction);
  }
  throw new Error(
    `NCTX chart keyboard focus was not acquired: ${chart}; ${JSON.stringify(snapshot)}`,
  );
}

async function expectSelectedRequest(observation: NativeContextObservation, chart?: TrendChartId) {
  let snapshot: ReturnType<typeof readTrendSelection> | undefined;
  const message = "NCTX selected request did not synchronize across charts and details";
  try {
    await browser.waitUntil(
      async () => {
        // 原因：逐个 RPC 加提前返回会漏掉其它图和实际焦点；同次只读 DOM 查询保留完整失败证据。
        snapshot = await browser.execute(readTrendSelection, chart);
        return (
          snapshot.ids.every((entry) => entry.id === observation.id) &&
          (!chart || snapshot.activeElement.inTargetGroup)
        );
      },
      { timeout: 10000, timeoutMsg: message },
    );
  } catch (cause) {
    throw new Error(
      `${message}; expected=${observation.id}; target=${chart ?? "none"}; ${JSON.stringify(snapshot)}`,
      { cause },
    );
  }
  expect(await nativeContextElement("request-details").getText()).toContain(
    observation.model.modelId,
  );
}

async function expectNumericMetric(key: string, value: number | null) {
  const text = await nativeContextElement("request-metric-" + key)
    .$("p.font-mono")
    .getText();
  if (value === null) expect(text).toBe("—");
  else expect(Number(text.replaceAll(",", "").replaceAll("，", ""))).toBe(Math.round(value));
}

export async function assertNativeContextTrendInteractions() {
  const target = await nativeContextCurrentTarget();
  const before = await getNativeContextStatus(target);
  const requestsBefore = await getUpstreamRequestRecordCount();
  const catalog = await listNativeContextObservations(target, before, {
    purpose: "main",
    limit: 200,
  });
  const main = [...catalog.items].sort(
    (left, right) => left.requestSeq - right.requestSeq || left.attemptIndex - right.attemptIndex,
  );
  expect(main.length).toBeGreaterThan(1);
  const current = main.filter((entry) => entry.segmentId === before.currentSegmentId).slice(-50);
  await openNativeContextDetails("trends");
  await chooseNativeContextOption("trend-segment", 0);
  await chooseNativeContextOption("trend-range", 0);
  await waitForTrendCount(current.length);
  await chooseNativeContextOption("trend-segment", 1);
  await chooseNativeContextOption("trend-range", 1);
  await waitForTrendCount(main.length);
  await expectRealTrendLines(main);

  await focusTrendKeyboardGroup("input-chart");
  await browser.keys("Home");
  await expectSelectedRequest(main[0]!, "input-chart");
  await browser.keys("ArrowRight");
  await expectSelectedRequest(main[1]!, "input-chart");
  await focusTrendKeyboardGroup("cache-chart");
  await browser.keys("End");
  await expectSelectedRequest(main.at(-1)!, "cache-chart");
  await focusTrendKeyboardGroup("image-chart");
  await browser.keys("Home");
  await expectSelectedRequest(main[0]!, "image-chart");
  await focusTrendKeyboardGroup("input-chart", "Shift+Tab");
  await browser.keys("ArrowRight");
  await expectSelectedRequest(main[1]!, "input-chart");
  await chooseNativeContextOption("trend-request", 1);
  await expectSelectedRequest(main[1]!);

  const beforeSeries = nativeContextElement("input-chart-series-before");
  if ((await beforeSeries.getAttribute("aria-pressed")) === "false") await beforeSeries.click();
  await beforeSeries.click();
  expect(await beforeSeries.getAttribute("aria-pressed")).toBe("false");
  expect(await nativeContextElement("request-metric-beforeEstimate").isExisting()).toBe(false);
  expect(await nativeContextElement("request-metric-afterEstimate").isExisting()).toBe(true);
  await waitForTrendCount(main.length);
  await beforeSeries.click();
  expect(await beforeSeries.getAttribute("aria-pressed")).toBe("true");
  await expectNumericMetric("beforeEstimate", main[1]!.beforeEstimate);
  await expectNumericMetric("actualInput", main[1]!.actualInputTokens);

  const zero = main.find((entry) => entry.actualInputTokens === 0);
  const unknownCache = main.find(
    (entry) => entry.actualInputTokens !== 0 && entry.cacheReadTokens === null,
  );
  expect(zero).toBeDefined();
  expect(unknownCache).toBeDefined();
  for (const observation of [zero!, unknownCache!]) {
    await chooseNativeContextOption(
      "trend-request",
      main.findIndex((entry) => entry.id === observation.id),
    );
    await expectSelectedRequest(observation);
    await expectNumericMetric("actualInput", observation.actualInputTokens);
    await expectNumericMetric("cacheRead", observation.cacheReadTokens);
    const hit = nativeContextCacheHitPercent(observation);
    const hitText = await nativeContextElement("request-metric-cacheHit")
      .$("p.font-mono")
      .getText();
    expect(hitText).toBe(
      hit === null
        ? "—"
        : new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(hit) + "%",
    );
  }
  await chooseNativeContextOption("cache-unit", 1);
  expect(await nativeContextElement("cache-chart-series-read").isExisting()).toBe(true);
  expect(await nativeContextElement("cache-chart-series-hit").isExisting()).toBe(false);
  await chooseNativeContextOption("image-unit", 1);
  expect(await nativeContextElement("image-chart-series-omitted").isExisting()).toBe(true);
  await waitForTrendCount(main.length);
  await chooseNativeContextOption("cache-unit", 0);
  await chooseNativeContextOption("image-unit", 0);

  const selectedId =
    await nativeContextElement("request-details").getAttribute("data-observation-id");
  const rangeText = await nativeContextElement("trend-range").getText();
  const segmentText = await nativeContextElement("trend-segment").getText();
  const events = await $$('[data-testid^="native-context-event-"]');
  expect(events.length).toBeGreaterThan(0);
  const event = events[0]!;
  const eventId = await event.getAttribute("data-testid");
  if (!eventId?.startsWith("native-context-event-"))
    throw new Error("NCTX event identity is missing");
  const operationId = eventId.slice("native-context-event-".length);
  const record = await readNativeContextRecord(target, before, operationId, {
    sourceLimit: 20,
    summaryLimitChars: 20000,
  });
  await event.click();
  await nativeContextElement("record-detail").waitForDisplayed();
  expect(await nativeContextElement("record-detail").getAttribute("data-operation-id")).toBe(
    operationId,
  );
  if (record.summaryTotalChars > 0) {
    expect(await nativeContextElement("record-summary").getProperty("textContent")).toBe(
      record.summary,
    );
  } else expect(await nativeContextElement("record-summary").isExisting()).toBe(false);
  await nativeContextElement("return-to-trends").click();
  await nativeContextElement("trends").waitForDisplayed();
  await waitForTrendCount(main.length);
  expect(await nativeContextElement("trend-range").getText()).toBe(rangeText);
  expect(await nativeContextElement("trend-segment").getText()).toBe(segmentText);
  expect(await nativeContextElement("request-details").getAttribute("data-observation-id")).toBe(
    selectedId,
  );
  await closeNativeContextDetails();
  await openNativeContextDetails("trends");
  await waitForTrendCount(main.length);
  expect(await nativeContextElement("request-details").getAttribute("data-observation-id")).toBe(
    selectedId,
  );
  const after = await getNativeContextStatus(target);
  expect(after.policy).toEqual(before.policy);
  expect(after.revision).toBe(before.revision);
  expect(await getUpstreamRequestRecordCount()).toBe(requestsBefore);
}
