import { useCallback, useMemo } from "react";
import { nativeContextCacheHitPercent } from "@zcode/shared/native-context-compression";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { NativeContextTrendSelection } from "@/store/nativeContextCompressionDraftStore.js";
import type { NativeContextObservation } from "../contract.js";
import {
  NativeContextTrendChart,
  type NativeContextChartPoint,
  type NativeContextChartSeries,
} from "./NativeContextTrendChart.js";

export function NativeContextTrendCharts({
  main,
  selection,
  scopeKey,
  selectedId,
  onSelect,
  onChange,
}: {
  main: readonly NativeContextObservation[];
  selection: NativeContextTrendSelection;
  scopeKey: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChange: (patch: Partial<NativeContextTrendSelection>) => void;
}) {
  const { intl } = useZCodeIntl();
  const inputPoints = useMemo(
    () =>
      main.map((observation) => ({
        observation,
        values: {
          before: observation.beforeEstimate,
          after: observation.afterEstimate,
          actual: observation.actualInputTokens,
          budget: observation.inputBudget,
          start: observation.startTokens,
          target: observation.targetTokens,
        },
      })),
    [main],
  );
  const cachePoints = useMemo(
    () =>
      main.map(
        (observation): NativeContextChartPoint => ({
          observation,
          values:
            selection.cacheUnit === "tokens"
              ? { read: observation.cacheReadTokens, create: observation.cacheCreateTokens }
              : { hit: nativeContextCacheHitPercent(observation) },
        }),
      ),
    [main, selection.cacheUnit],
  );
  const imagePoints = useMemo(
    () =>
      main.map(
        (observation): NativeContextChartPoint => ({
          observation,
          values:
            selection.imageUnit === "bytes"
              ? {
                  before:
                    observation.images.sourceCoverage === observation.images.sourceCount
                      ? observation.images.beforeBytes
                      : null,
                  after: observation.images.afterBytes,
                }
              : {
                  sent: observation.images.sentCount,
                  omitted: observation.images.omittedCount,
                  folded: observation.images.foldedCount,
                  resized: observation.images.resizedCount,
                  restored: observation.images.restoredCount,
                },
        }),
      ),
    [main, selection.imageUnit],
  );
  const series = useCallback(
    (key: string, message: string, color: number, dash?: string): NativeContextChartSeries => ({
      key,
      label: intl.formatMessage({ id: "nativeContext." + message }),
      color: "var(--color-usage-chart-" + color + ")",
      ...(dash ? { dash } : {}),
    }),
    [intl],
  );
  const inputSeries = useMemo(
    () => [
      series("before", "beforeEstimate", 1, "5 4"),
      series("after", "afterEstimate", 2),
      { ...series("actual", "actualInput", 3), kind: "point" as const },
      series("budget", "inputBudget", 4, "2 5"),
      series("start", "startThreshold", 5, "6 5"),
      series("target", "targetThreshold", 2, "2 6"),
    ],
    [series],
  );
  const cacheSeries = useMemo(
    () =>
      selection.cacheUnit === "tokens"
        ? [series("read", "cacheRead", 1), series("create", "cacheCreate", 5)]
        : [series("hit", "cacheHit", 1)],
    [series, selection.cacheUnit],
  );
  const imageSeries = useMemo(
    () =>
      selection.imageUnit === "bytes"
        ? [series("before", "sourceBytes", 1, "5 4"), series("after", "sentBytes", 2)]
        : [
            series("sent", "sentImages", 2),
            series("omitted", "omittedImages", 5),
            series("folded", "foldedImages", 4, "4 3"),
            series("resized", "resizedImages", 1),
            series("restored", "restoredImages", 3),
          ],
    [series, selection.imageUnit],
  );
  return (
    <>
      <NativeContextTrendChart
        title={intl.formatMessage({ id: "nativeContext.inputTrend" })}
        testId="native-context-input-chart"
        scopeKey={scopeKey}
        points={inputPoints}
        series={inputSeries}
        selectedId={selectedId}
        onSelect={onSelect}
        unit="tokens"
      />
      <div className="grid gap-4 md:grid-cols-2">
        <div className="min-w-0 space-y-2">
          <Select
            value={selection.cacheUnit}
            onValueChange={(cacheUnit) => {
              if (cacheUnit === "tokens" || cacheUnit === "hit") onChange({ cacheUnit });
            }}
          >
            <SelectTrigger
              className="min-h-11 w-full"
              aria-label={intl.formatMessage({ id: "nativeContext.cacheTrend" })}
              data-testid="native-context-cache-unit"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="hit">
                {intl.formatMessage({ id: "nativeContext.cacheHit" })}
              </SelectItem>
              <SelectItem value="tokens">
                {intl.formatMessage({ id: "nativeContext.cacheTokens" })}
              </SelectItem>
            </SelectContent>
          </Select>
          <NativeContextTrendChart
            title={intl.formatMessage({ id: "nativeContext.cacheTrend" })}
            testId="native-context-cache-chart"
            scopeKey={scopeKey}
            points={cachePoints}
            series={cacheSeries}
            selectedId={selectedId}
            onSelect={onSelect}
            unit={selection.cacheUnit === "tokens" ? "tokens" : "%"}
          />
        </div>
        <div className="min-w-0 space-y-2">
          <Select
            value={selection.imageUnit}
            onValueChange={(imageUnit) => {
              if (imageUnit === "bytes" || imageUnit === "count") onChange({ imageUnit });
            }}
          >
            <SelectTrigger
              className="min-h-11 w-full"
              aria-label={intl.formatMessage({ id: "nativeContext.imageTrend" })}
              data-testid="native-context-image-unit"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="bytes">
                {intl.formatMessage({ id: "nativeContext.imageBytes" })}
              </SelectItem>
              <SelectItem value="count">
                {intl.formatMessage({ id: "nativeContext.imageCount" })}
              </SelectItem>
            </SelectContent>
          </Select>
          <NativeContextTrendChart
            title={intl.formatMessage({ id: "nativeContext.imageTrend" })}
            testId="native-context-image-chart"
            scopeKey={scopeKey}
            points={imagePoints}
            series={imageSeries}
            selectedId={selectedId}
            onSelect={onSelect}
            unit={
              selection.imageUnit === "bytes"
                ? "B"
                : intl.formatMessage({ id: "nativeContext.imagesUnit" })
            }
          />
        </div>
      </div>
    </>
  );
}
