import { type ComponentProps, type MouseEvent, type TouchEvent, useCallback, useMemo } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button.js";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useNativeContextDraftStore } from "@/store/nativeContextCompressionDraftStore.js";
import { formatContextBytes, formatContextNumber } from "../domain/format.js";
import {
  buildNativeContextChartRows,
  nativeContextChartSegment,
  type NativeContextChartPoint,
  type NativeContextChartRow,
  type NativeContextChartSeries,
} from "../domain/chart.js";

export type { NativeContextChartPoint, NativeContextChartSeries } from "../domain/chart.js";

const CHART_MARGIN = { top: 12, right: 18, bottom: 8, left: 0 } as const;
const X_AXIS_HEIGHT = 30;
type TooltipProps = ComponentProps<typeof ChartTooltipContent>;

function NativeChartTooltip(props: TooltipProps) {
  const payload = props.payload?.filter((item) => typeof item.value === "number");
  return payload?.length ? <ChartTooltipContent {...props} payload={payload} /> : null;
}

export function NativeContextTrendChart({
  title,
  points,
  series,
  selectedId,
  onSelect,
  unit,
  testId,
  scopeKey,
}: {
  title: string;
  points: readonly NativeContextChartPoint[];
  series: readonly NativeContextChartSeries[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  unit: string;
  testId: string;
  scopeKey: string;
}) {
  const { intl, locale } = useZCodeIntl();
  const hidden = useNativeContextDraftStore((state) => state.trends[scopeKey]?.hiddenSeries);
  const visibleSeries = useMemo(
    () => series.filter((entry) => !hidden?.includes(testId + ":" + entry.key)),
    [hidden, series, testId],
  );
  const chartData = useMemo(
    () => buildNativeContextChartRows(points, selectedId),
    [points, selectedId],
  );
  const config = useMemo<ChartConfig>(
    () =>
      Object.fromEntries(
        series.map((entry) => [entry.key, { label: entry.label, color: entry.color }]),
      ),
    [series],
  );
  const lineSeries = useMemo(
    () =>
      visibleSeries.flatMap((entry) =>
        ["own", "inherited"].map((origin) => ({
          ...entry,
          origin,
          dataKey: (row: NativeContextChartRow) =>
            row.observation?.origin === origin ? (row.values[entry.key] ?? null) : null,
        })),
      ),
    [visibleSeries],
  );
  const maximum = useMemo(() => {
    if (unit === "%") return 100;
    let largest = 0;
    for (const point of points) {
      for (const entry of visibleSeries) largest = Math.max(largest, point.values[entry.key] ?? 0);
    }
    return largest > 0 ? Math.ceil(largest * 1.08) : 1;
  }, [points, unit, visibleSeries]);
  const ticks = useMemo(
    () =>
      [...new Set([0, 1, 2, 3].map((step) => Math.round(((points.length - 1) * step) / 3)))].filter(
        (index) => index >= 0,
      ),
    [points.length],
  );
  const boundaries = useMemo(
    () =>
      points.flatMap((point, index) => {
        const previous = points[index - 1];
        return previous &&
          (nativeContextChartSegment(previous) !== nativeContextChartSegment(point) ||
            previous.observation.policyVersion !== point.observation.policyVersion)
          ? [{ index, id: point.observation.id }]
          : [];
      }),
    [points],
  );
  const selectedIndex = points.findIndex((point) => point.observation.id === selectedId);
  const yAxisWidth = unit === "B" ? 76 : 64;
  const knownPoints = points.filter((point) =>
    series.some((entry) => point.values[entry.key] != null),
  ).length;
  const sampledPoints = chartData.filter((row) => row.observation !== null).length;
  const formatValue = useCallback(
    (value: unknown) => {
      if (typeof value !== "number") return "—";
      if (unit === "B") return formatContextBytes(value, locale);
      if (unit === "%")
        return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value) + "%";
      return formatContextNumber(value, locale);
    },
    [locale, unit],
  );
  const formatTooltipLabel = useCallback(
    (_: unknown, payload: readonly { payload?: unknown }[]) => {
      const row = payload[0]?.payload as NativeContextChartRow | undefined;
      return row?.observation
        ? intl.formatMessage(
            { id: "nativeContext.requestNumber" },
            { request: row.observation.requestSeq },
          )
        : "";
    },
    [intl],
  );
  const formatTooltipValue = useCallback(
    (value: unknown, name: unknown) => (
      <div className="flex flex-1 items-center justify-between gap-3">
        <span className="text-foreground-subtle">{String(name)}</span>
        <span className="font-mono tabular-nums">{formatValue(value)}</span>
      </div>
    ),
    [formatValue],
  );
  const tooltip = useMemo(
    () => <NativeChartTooltip labelFormatter={formatTooltipLabel} formatter={formatTooltipValue} />,
    [formatTooltipLabel, formatTooltipValue],
  );
  const selectChartRow = useCallback(
    (
      _state: { activeTooltipIndex?: string | number | null },
      event: MouseEvent<Element> | TouchEvent<Element>,
    ) => {
      if (
        "changedTouches" in event &&
        (event.changedTouches.length !== 1 || event.touches.length > 0)
      )
        return;
      const pointer = "changedTouches" in event ? event.changedTouches[0] : event;
      if (!pointer) return;
      const owner = event.currentTarget;
      // Recharts 的声明以 SVG 为目标，实际事件由 HTML 容器承载；取得布局尺寸后才定位。
      if (!(owner instanceof HTMLElement)) return;
      const rect = owner.getBoundingClientRect();
      const left = CHART_MARGIN.left + yAxisWidth;
      const right = owner.offsetWidth - CHART_MARGIN.right;
      const bottom = owner.offsetHeight - CHART_MARGIN.bottom - X_AXIS_HEIGHT;
      if (rect.width <= 0 || rect.height <= 0 || right <= left || bottom <= CHART_MARGIN.top)
        return;
      // 原因：无移动触摸不更新 hover 索引；按本次坐标定位原始请求，不能借用旧 Tooltip。
      // 保留浮点坐标，避免大账本的像素取整和采样空行把触摸映射到相邻请求。
      const x = ((pointer.clientX - rect.left) * owner.offsetWidth) / rect.width;
      const y = ((pointer.clientY - rect.top) * owner.offsetHeight) / rect.height;
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < left ||
        x > right ||
        y < CHART_MARGIN.top ||
        y > bottom
      )
        return;
      const point = points[Math.round(((x - left) / (right - left)) * (points.length - 1))];
      if (point) onSelect(point.observation.id);
    },
    [onSelect, points, yAxisWidth],
  );

  const toggleSeries = (key: string) => {
    const selection = useNativeContextDraftStore.getState().trends[scopeKey];
    const current = selection?.hiddenSeries ?? [];
    const fullKey = testId + ":" + key;
    useNativeContextDraftStore.getState().selectTrend(scopeKey, {
      hiddenSeries: current.includes(fullKey)
        ? current.filter((entry) => entry !== fullKey)
        : [...current, fullKey],
    });
  };

  return (
    <section
      className="min-w-0 rounded-xl border border-border bg-card p-3"
      data-testid={testId}
      data-selected-observation-id={selectedId ?? ""}
      data-request-count={points.length}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-ui-base font-medium">{title}</h3>
        <span className="text-ui-xs text-foreground-subtle">{unit}</span>
      </div>
      <div className="flex flex-wrap gap-x-2 gap-y-1">
        {series.map((entry) => (
          <Button
            type="button"
            key={entry.key}
            variant="ghost"
            size="sm"
            className="min-h-11 gap-1.5 px-1.5 text-ui-xs"
            aria-pressed={!hidden?.includes(testId + ":" + entry.key)}
            onClick={() => toggleSeries(entry.key)}
            data-testid={testId + "-series-" + entry.key}
          >
            <svg width="24" height="12" viewBox="0 0 24 12" aria-hidden="true">
              {entry.kind === "point" ? (
                <circle cx="12" cy="6" r="3" fill={entry.color} />
              ) : (
                <line
                  x1="1"
                  x2="23"
                  y1="6"
                  y2="6"
                  stroke={entry.color}
                  strokeWidth="2"
                  strokeDasharray={entry.dash}
                />
              )}
            </svg>
            <span
              className={
                hidden?.includes(testId + ":" + entry.key)
                  ? "text-foreground-subtle line-through"
                  : ""
              }
            >
              {entry.label}
            </span>
          </Button>
        ))}
      </div>
      <p className="sr-only" id={testId + "-summary"}>
        {intl.formatMessage(
          { id: "nativeContext.chartSummary" },
          {
            title,
            count: points.length,
            unknown: points.length - knownPoints,
          },
        )}
      </p>
      <div
        tabIndex={0}
        role="group"
        aria-label={title}
        aria-describedby={testId + "-summary"}
        className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const nextIndex =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? points.length - 1
                : (selectedIndex < 0 ? points.length - 1 : selectedIndex) +
                  (event.key === "ArrowLeft" ? -1 : 1);
          const next = points[Math.max(0, Math.min(points.length - 1, nextIndex))];
          if (next) onSelect(next.observation.id);
        }}
      >
        <ChartContainer config={config} className="mt-2 h-56 w-full aspect-auto text-ui-xs">
          <LineChart<NativeContextChartRow>
            accessibilityLayer
            data={chartData}
            margin={CHART_MARGIN}
            onClick={selectChartRow}
            onTouchEnd={selectChartRow}
          >
            <CartesianGrid vertical={false} strokeDasharray="3 4" />
            <XAxis<NativeContextChartRow, number>
              type="number"
              dataKey="index"
              height={X_AXIS_HEIGHT}
              domain={[0, Math.max(1, points.length - 1)]}
              ticks={ticks}
              tickLine={false}
              axisLine={false}
              interval={0}
              minTickGap={0}
              tickMargin={8}
              tickFormatter={(index: number) => {
                const point = points[index];
                return point ? "#" + point.observation.requestSeq : "";
              }}
            />
            {/* 全零域的分数 tick 会被整数单位格式化成重复标签；仅百分比允许小数刻度。 */}
            <YAxis
              type="number"
              domain={[0, maximum]}
              allowDecimals={unit === "%"}
              width={yAxisWidth}
              tickLine={false}
              axisLine={false}
              tickCount={5}
              tickFormatter={formatValue}
            />
            <ChartTooltip cursor={false} content={tooltip} />
            {boundaries.map((boundary) => (
              <ReferenceLine
                key={boundary.id}
                x={boundary.index}
                stroke="var(--color-border)"
                strokeDasharray="2 5"
              />
            ))}
            {selectedIndex >= 0 ? (
              <ReferenceLine
                x={selectedIndex}
                stroke="var(--color-foreground-subtle)"
                strokeDasharray="4 4"
              />
            ) : null}
            {points.flatMap((point, index) =>
              point.observation.operationIds.length > 0
                ? [
                    <ReferenceLine
                      key={"event:" + point.observation.id}
                      x={index}
                      stroke="var(--color-usage-chart-5)"
                      strokeDasharray="1 4"
                    />,
                  ]
                : [],
            )}
            {/* 原因：实测点继承透明描边，默认白填充在浅色中难辨；仅点系列显式沿用图例色。 */}
            {lineSeries.map((entry) => (
              <Line<NativeContextChartRow, number | null>
                key={entry.key + ":" + entry.origin}
                className={"native-context-series-" + entry.key + "-" + entry.origin}
                type="linear"
                name={entry.label}
                dataKey={entry.dataKey}
                connectNulls={false}
                stroke={entry.color}
                strokeWidth={2}
                strokeOpacity={entry.kind === "point" ? 0 : 1}
                strokeDasharray={entry.origin === "inherited" ? "3 5" : entry.dash}
                dot={
                  entry.kind === "point"
                    ? { r: 2.5, fill: entry.color }
                    : points.length <= 200
                      ? { r: 2.5 }
                      : false
                }
                activeDot={{ r: 4 }}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ChartContainer>
      </div>
      {knownPoints === 0 ? (
        <p className="mt-2 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "nativeContext.noMeasurement" })}
        </p>
      ) : null}
      {sampledPoints < points.length ? (
        <p className="mt-2 text-ui-xs text-foreground-subtle">
          {intl.formatMessage(
            { id: "nativeContext.chartReduced" },
            { count: points.length, shown: sampledPoints },
          )}
        </p>
      ) : null}
    </section>
  );
}
