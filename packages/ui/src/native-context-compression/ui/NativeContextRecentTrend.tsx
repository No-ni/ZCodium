import { useEffect, useMemo, useRef, useState } from "react";
import { Line, LineChart, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button.js";
import { ChartContainer } from "@/components/ui/chart.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { NativeContextObservation, NativeContextReadController } from "../contract.js";
import { buildNativeContextChartRows, type NativeContextChartRow } from "../domain/chart.js";
import { nativeContextVersionKey } from "../domain/format.js";

/** 浮层和概览只读短尾；点击才进入完整趋势，不读取正文或大图片。 */
export default function NativeContextRecentTrend({
  read,
  onOpenTrends,
  compact = false,
}: {
  read: NativeContextReadController;
  onOpenTrends: () => void;
  compact?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const { scopeKey, observations, unavailable, status } = read;
  const version = status ? nativeContextVersionKey(status) : "";
  const currentSegmentId = status?.currentSegmentId ?? null;
  const [data, setData] = useState<{
    scopeKey: string;
    version: string;
    currentSegmentId: string;
    items: NativeContextObservation[];
    failed: boolean;
  } | null>(null);
  const requestRef = useRef(0);
  useEffect(() => {
    if (!version || !currentSegmentId || unavailable) return;
    const request = ++requestRef.current;
    // 原因：最新主请求可能仍在 compact 前；短尾也必须按 owner 的当前边界读取。
    void observations({
      purpose: "main",
      limit: 20,
      segmentId: currentSegmentId,
    }).then(
      (page) => {
        if (request !== requestRef.current) return;
        const ordered = [...page.items].sort(
          (left, right) =>
            left.requestSeq - right.requestSeq || left.attemptIndex - right.attemptIndex,
        );
        setData({
          scopeKey,
          version,
          currentSegmentId,
          items: ordered,
          failed: false,
        });
      },
      () => {
        if (request === requestRef.current)
          setData((current) => ({
            scopeKey,
            version,
            currentSegmentId,
            items:
              current?.scopeKey === scopeKey && current.currentSegmentId === currentSegmentId
                ? current.items
                : [],
            failed: true,
          }));
      },
    );
    return () => {
      requestRef.current += 1;
    };
  }, [observations, scopeKey, unavailable, version, currentSegmentId]);
  const owned =
    data?.scopeKey === scopeKey && (data.version === version || unavailable) ? data : null;
  const points = useMemo(
    () =>
      (owned?.items ?? []).map((observation) => ({
        observation,
        values: { after: observation.afterEstimate },
      })),
    [owned?.items],
  );
  const rows = useMemo(() => buildNativeContextChartRows(points, null), [points]);
  const config = useMemo(
    () => ({
      after: {
        label: intl.formatMessage({ id: "nativeContext.afterEstimate" }),
        color: "var(--color-usage-chart-2)",
      },
    }),
    [intl],
  );
  const known = points.some((point) => point.values.after !== null);
  return (
    <Button
      type="button"
      variant="ghost"
      className="h-auto w-full min-w-0 flex-col items-stretch gap-1.5 rounded-lg border border-border bg-surface p-2.5 text-left"
      onClick={onOpenTrends}
      data-testid={
        compact ? "native-context-recent-trend-popover" : "native-context-recent-trend-overview"
      }
      data-current-segment-id={owned?.currentSegmentId ?? ""}
      data-request-count={points.length}
      data-loading={Boolean(read.loading || (version && !owned && !unavailable))}
    >
      <span className="text-ui-sm font-medium">
        {intl.formatMessage({ id: "nativeContext.recentTrend" })}
      </span>
      <span className="text-ui-xs text-foreground-subtle">
        {intl.formatMessage({ id: "nativeContext.recentTrendHelp" }, { count: points.length })}
      </span>
      {known ? (
        <ChartContainer
          config={config}
          className={compact ? "h-16 w-full aspect-auto" : "h-28 w-full aspect-auto"}
          aria-hidden="true"
        >
          <LineChart<NativeContextChartRow>
            data={rows}
            accessibilityLayer={false}
            margin={{ top: 5, bottom: 5, left: 5, right: 5 }}
          >
            <XAxis
              type="number"
              dataKey="index"
              hide
              domain={[0, Math.max(1, points.length - 1)]}
            />
            <YAxis hide domain={[0, "auto"]} />
            {(["own", "inherited"] as const).map((origin) => (
              <Line<NativeContextChartRow, number | null>
                key={origin}
                className={"native-context-series-after-" + origin}
                dataKey={(row) =>
                  row.observation?.origin === origin ? (row.values.after ?? null) : null
                }
                type="linear"
                stroke="var(--color-usage-chart-2)"
                strokeWidth={2}
                connectNulls={false}
                strokeDasharray={origin === "inherited" ? "3 5" : undefined}
                dot={points.length === 1}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ChartContainer>
      ) : (
        <span className="py-2 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({
            id: owned?.failed
              ? "nativeContext.readFailed"
              : owned
                ? "nativeContext.noMeasurement"
                : unavailable
                  ? "nativeContext.offlineHelp"
                  : !status && !read.loading
                    ? "nativeContext.beforeCreationHelp"
                    : "nativeContext.loading",
          })}
        </span>
      )}
    </Button>
  );
}
