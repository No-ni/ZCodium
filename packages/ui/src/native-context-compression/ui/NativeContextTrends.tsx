import { useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  INITIAL_NATIVE_CONTEXT_TREND_SELECTION,
  useNativeContextDraftStore,
  type NativeContextTrendSelection,
} from "@/store/nativeContextCompressionDraftStore.js";
import type { NativeContextReadController } from "../contract.js";
import { formatContextNumber, nativeContextRequestSaving } from "../domain/format.js";
import { useNativeContextTrendData } from "../app/useTrendData.js";
import { NativeContextTrendCharts } from "./NativeContextTrendCharts.js";
import { NativeContextRequestDetails } from "./NativeContextRequestDetails.js";
import { NativeContextMaintenanceSummary } from "./NativeContextMaintenanceSummary.js";
import { summarizeNativeContextUsage } from "../domain/usage.js";
import { nativeContextMainRequests, nativeContextTrendSegments } from "../domain/chart.js";

export function NativeContextTrends({
  read,
  onOpenRecord,
  onOpenRecords,
  onParameters,
}: {
  read: NativeContextReadController;
  onOpenRecord: (operationId: string) => void;
  onOpenRecords: () => void;
  onParameters: () => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const selection =
    useNativeContextDraftStore((state) => state.trends[read.scopeKey]) ??
    INITIAL_NATIVE_CONTEXT_TREND_SELECTION;
  const select = useCallback(
    (patch: Partial<NativeContextTrendSelection>) => {
      useNativeContextDraftStore.getState().selectTrend(read.scopeKey, patch);
    },
    [read.scopeKey],
  );
  const { data, activeSegmentId, queryKey, loadMore, loadMaintenance, refresh } =
    useNativeContextTrendData(read, selection);
  const observations = data?.observations;
  const main = useMemo(
    () => nativeContextMainRequests(observations ?? [], activeSegmentId, selection.range),
    [observations, activeSegmentId, selection.range],
  );
  const segments = useMemo(
    () =>
      nativeContextTrendSegments(
        observations ?? [],
        data?.maintenance ?? [],
        data?.operations ?? [],
      ),
    [observations, data?.maintenance, data?.operations],
  );
  const selected =
    main.find((item) => item.id === selection.observationId) ??
    (selection.observationId === null ? main.at(-1) : null);
  const selectedIndex = selected ? main.findIndex((item) => item.id === selected.id) : -1;
  const latest = main.at(-1);
  const saving = latest ? nativeContextRequestSaving(latest) : null;
  const onSelect = useCallback((observationId: string) => select({ observationId }), [select]);
  const firstSequence = main[0]?.requestSeq ?? null;
  const maintenance = (data?.maintenance ?? []).filter(
    (item) =>
      item.origin === "own" &&
      (!activeSegmentId || item.segmentId === activeSegmentId) &&
      (firstSequence === null || item.requestSeq >= firstSequence),
  );
  const segmentValue =
    selection.segmentScope === "current"
      ? "current"
      : selection.segmentScope === "all"
        ? "all"
        : "segment:" + (selection.segmentId ?? "");
  const maintenanceInput =
    data && (!data.maintenanceFailed || maintenance.length > 0)
      ? summarizeNativeContextUsage(maintenance, "actualInputTokens")
      : null;
  const maintenanceOutput =
    data && (!data.maintenanceFailed || maintenance.length > 0)
      ? summarizeNativeContextUsage(maintenance, "outputTokens")
      : null;
  const unknownMaintenance = maintenance.filter(
    (item) => item.actualInputTokens === null || item.outputTokens === null,
  ).length;

  return (
    <div
      className="space-y-4"
      data-testid="native-context-trends"
      data-current-segment-id={data?.currentSegmentId ?? ""}
      data-active-segment-id={activeSegmentId ?? ""}
      data-maintenance-count={maintenance.length}
      data-loading={Boolean(data?.loading || read.loading)}
      data-failed={Boolean(data?.failed)}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "nativeContext.segment" })}
          <Select
            value={segmentValue}
            onValueChange={(value) => {
              if (value === "current") select({ segmentScope: "current", segmentId: null });
              else if (value === "all") select({ segmentScope: "all", segmentId: null });
              else if (value.startsWith("segment:"))
                select({ segmentScope: "chosen", segmentId: value.slice(8) });
            }}
          >
            <SelectTrigger
              className="min-h-11 w-full min-w-0"
              data-testid="native-context-trend-segment"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="current">
                {intl.formatMessage({ id: "nativeContext.currentSegment" })}
              </SelectItem>
              <SelectItem value="all">
                {intl.formatMessage({ id: "nativeContext.allLoadedSegments" })}
              </SelectItem>
              {segments.map((item) => (
                <SelectItem key={item.segmentId} value={"segment:" + item.segmentId}>
                  {item.model
                    ? item.model.providerId + " / " + item.model.modelId
                    : intl.formatMessage({
                        id: "nativeContext.historySegment",
                      })}{" "}
                  · v{item.policyVersion} · g{item.generation}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="space-y-1 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "nativeContext.range" })}
          <Select
            value={selection.range}
            onValueChange={(range) => {
              if (range === "50" || range === "200" || range === "segment") select({ range });
            }}
          >
            <SelectTrigger
              className="min-h-11 w-full min-w-0"
              data-testid="native-context-trend-range"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="50">
                {intl.formatMessage({ id: "nativeContext.recent50" })}
              </SelectItem>
              <SelectItem value="200">
                {intl.formatMessage({ id: "nativeContext.recent200" })}
              </SelectItem>
              <SelectItem value="segment">
                {intl.formatMessage({ id: "nativeContext.browseSegments" })}
              </SelectItem>
            </SelectContent>
          </Select>
        </label>
      </div>
      <div className="grid gap-2 sm:grid-cols-3" data-testid="native-context-trend-summary">
        <div className="rounded-xl border border-border bg-surface p-3">
          <p className="text-ui-xs text-foreground-subtle">
            {intl.formatMessage({
              id:
                saving !== null && saving < 0
                  ? "nativeContext.latestIncrease"
                  : "nativeContext.latestSaving",
            })}
          </p>
          <p className="mt-1 font-mono text-ui-lg">
            {formatContextNumber(saving === null ? null : Math.abs(saving), locale)}
          </p>
        </div>
        <div className="rounded-xl border border-border bg-surface p-3">
          <p className="text-ui-xs text-foreground-subtle">
            {intl.formatMessage({
              id: "nativeContext.loadedMaintenanceTotals",
            })}
          </p>
          <p className="mt-1 font-mono text-ui-lg">
            {formatContextNumber(maintenanceInput?.value, locale)} /{" "}
            {formatContextNumber(maintenanceOutput?.value, locale)}
          </p>
          {unknownMaintenance > 0 ? (
            <p className="text-ui-xs text-foreground-subtle">
              {intl.formatMessage(
                { id: "nativeContext.unknownRequests" },
                { count: unknownMaintenance },
              )}
            </p>
          ) : null}
        </div>
        <div className="rounded-xl border border-border bg-surface p-3">
          <p className="text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "nativeContext.currentEffectiveBlocks" })}
          </p>
          <p className="mt-1 font-mono text-ui-lg">
            {formatContextNumber(read.status?.effectiveBlocks, locale)}
          </p>
        </div>
      </div>
      <p className="text-ui-xs text-foreground-subtle" role="status">
        {intl.formatMessage(
          { id: "nativeContext.loadedRange" },
          {
            count: main.length,
            time: data?.capturedAt ? new Date(data.capturedAt).toLocaleString(locale) : "—",
          },
        )}
      </p>
      {data?.failed ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 text-ui-base text-destructive"
        >
          {intl.formatMessage({ id: "nativeContext.readFailed" })}
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={refresh}
            disabled={read.unavailable}
          >
            {intl.formatMessage({ id: "nativeContext.retry" })}
          </Button>
        </div>
      ) : null}
      {(data?.loading || read.loading) && main.length === 0 ? (
        <p role="status" className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "nativeContext.loading" })}
        </p>
      ) : main.length === 0 ? (
        <div
          className="rounded-xl border border-border bg-surface p-6 text-center"
          data-testid="native-context-trend-empty"
        >
          <p className="text-ui-base font-medium">
            {intl.formatMessage({ id: "nativeContext.noHistory" })}
          </p>
          <p className="mt-2 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "nativeContext.noHistoryHelp" })}
          </p>
          <Button type="button" variant="outline" className="mt-3 min-h-11" onClick={onParameters}>
            {intl.formatMessage({ id: "nativeContext.adjustParameters" })}
          </Button>
        </div>
      ) : (
        <>
          <NativeContextTrendCharts
            main={main}
            selection={selection}
            scopeKey={read.scopeKey}
            selectedId={selected?.id ?? null}
            onSelect={onSelect}
            onChange={select}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={selectedIndex <= 0}
              onClick={() => {
                const next = main[selectedIndex - 1];
                if (next) onSelect(next.id);
              }}
              aria-label={intl.formatMessage({
                id: "nativeContext.previousRequest",
              })}
            >
              ←
            </Button>
            <Select value={selected?.id ?? "none"} onValueChange={onSelect}>
              <SelectTrigger
                className="min-h-11 min-w-0 flex-1"
                aria-label={intl.formatMessage({ id: "nativeContext.request" })}
                data-testid="native-context-trend-request"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {!selected ? (
                  <SelectItem value="none" disabled>
                    {intl.formatMessage({
                      id: "nativeContext.selectRequestPrompt",
                    })}
                  </SelectItem>
                ) : null}
                {main.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    #{item.requestSeq} · {item.model.modelId} ·{" "}
                    {intl.formatMessage({
                      id: "nativeContext.requestStatus." + item.status,
                    })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={selectedIndex < 0 || selectedIndex >= main.length - 1}
              onClick={() => {
                const next = main[selectedIndex + 1];
                if (next) onSelect(next.id);
              }}
              aria-label={intl.formatMessage({
                id: "nativeContext.nextRequest",
              })}
            >
              →
            </Button>
          </div>
          {selected ? (
            <NativeContextRequestDetails
              observation={selected}
              hiddenSeries={selection.hiddenSeries}
              operations={data?.operations ?? []}
              maintenance={maintenance}
              onOpenRecord={onOpenRecord}
              onParameters={onParameters}
            />
          ) : null}
        </>
      )}
      <NativeContextMaintenanceSummary
        read={read}
        data={data}
        main={main}
        maintenance={maintenance}
        activeSegmentId={activeSegmentId}
        onOpenRecord={onOpenRecord}
        onOpenRecords={onOpenRecords}
        onLoadMaintenance={loadMaintenance}
        onRetry={refresh}
      />
      {selection.range === "segment" && data?.queryKey === queryKey && data.nextCursor !== null ? (
        <Button
          type="button"
          variant="outline"
          className="min-h-11 w-full"
          disabled={data.loading || read.unavailable}
          onClick={() => void loadMore()}
          data-testid="native-context-trends-load-more"
        >
          {intl.formatMessage({ id: "nativeContext.loadMore" })}
        </Button>
      ) : null}
    </div>
  );
}
