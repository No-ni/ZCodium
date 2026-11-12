import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { NativeContextObservation, NativeContextReadController } from "../contract.js";
import type { NativeContextTrendData } from "../app/useTrendData.js";
import { formatContextNumber } from "../domain/format.js";
import { summarizeNativeContextUsage } from "../domain/usage.js";

export function NativeContextMaintenanceSummary({
  read,
  data,
  main,
  maintenance,
  activeSegmentId,
  onOpenRecord,
  onOpenRecords,
  onLoadMaintenance,
  onRetry,
}: {
  read: NativeContextReadController;
  data: NativeContextTrendData | null;
  main: readonly NativeContextObservation[];
  maintenance: readonly NativeContextObservation[];
  activeSegmentId: string | null;
  onOpenRecord: (operationId: string) => void;
  onOpenRecords: () => void;
  onLoadMaintenance: () => Promise<void>;
  onRetry: () => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const grouped = [
    ...new Map(maintenance.map((item) => [JSON.stringify(item.model), item.model])).entries(),
  ].map(([key, model]) => ({
    key,
    model,
    observations: maintenance.filter((item) => JSON.stringify(item.model) === key),
  }));
  const associatedIds = new Set([...main, ...maintenance].flatMap((item) => item.operationIds));
  const first = main[0]?.requestSeq ?? null;
  const scopedOperations = (data?.operations ?? []).filter(
    (operation) => !activeSegmentId || operation.segmentId === activeSegmentId,
  );
  const events = scopedOperations.filter(
    (operation) =>
      associatedIds.has(operation.operationId) ||
      (operation.anchorRequestSeq != null &&
        (first === null || operation.anchorRequestSeq >= first)),
  );
  const unlinked = scopedOperations.filter(
    (operation) => operation.anchorRequestSeq == null && !associatedIds.has(operation.operationId),
  );
  const incomplete = data?.maintenanceCursor != null || data?.decisionCursor != null;
  const inherited = main.some((item) => item.origin === "inherited");
  return (
    <>
      <section className="rounded-xl border border-border bg-surface p-3">
        <h3 className="text-ui-base font-medium">
          {intl.formatMessage({ id: "nativeContext.maintenanceUsage" })}
        </h3>
        <p className="mt-1 text-ui-sm text-foreground-subtle">
          {intl.formatMessage(
            { id: "nativeContext.loadedMaintenance" },
            { count: maintenance.length },
          )}
        </p>
        {grouped.map((group) => {
          const input = summarizeNativeContextUsage(group.observations, "actualInputTokens");
          const output = summarizeNativeContextUsage(group.observations, "outputTokens");
          const cacheRead = summarizeNativeContextUsage(group.observations, "cacheReadTokens");
          const cacheCreate = summarizeNativeContextUsage(group.observations, "cacheCreateTokens");
          return (
            <div key={group.key} className="mt-3 rounded-lg border border-border bg-card p-3">
              <p className="break-words text-ui-sm font-medium">
                {group.model.providerId} / {group.model.modelId}
              </p>
              <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {(
                  [
                    ["maintenanceInput", input],
                    ["maintenanceOutput", output],
                    ["cacheRead", cacheRead],
                    ["cacheCreate", cacheCreate],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label}>
                    <p className="text-ui-xs text-foreground-subtle">
                      {intl.formatMessage({ id: "nativeContext." + label })}
                    </p>
                    <p className="font-mono text-ui-base">
                      {formatContextNumber(value.value, locale)}
                    </p>
                    {value.unknown > 0 ? (
                      <p className="text-ui-xs text-foreground-subtle">
                        {intl.formatMessage(
                          { id: "nativeContext.unknownRequests" },
                          { count: value.unknown },
                        )}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        {incomplete ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <p className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "nativeContext.partialMaintenance" })}
            </p>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={data?.loading || data?.loadingMaintenance || read.unavailable}
              onClick={() => void onLoadMaintenance()}
              data-testid="native-context-maintenance-load-more"
            >
              {intl.formatMessage({
                id: data?.loadingMaintenance ? "nativeContext.loading" : "nativeContext.loadMore",
              })}
            </Button>
          </div>
        ) : null}
        {data?.maintenanceFailed ? (
          <div
            role="alert"
            className="mt-2 flex flex-wrap items-center gap-2 text-ui-sm text-destructive"
          >
            {intl.formatMessage({ id: "nativeContext.usageReadFailed" })}
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={read.unavailable}
              onClick={onRetry}
            >
              {intl.formatMessage({ id: "nativeContext.retry" })}
            </Button>
          </div>
        ) : null}
        <p className="mt-3 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "nativeContext.unknownMeasurementsHelp" })}
        </p>
        {inherited ? (
          <p className="mt-1 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "nativeContext.inheritedHelp" })}
          </p>
        ) : null}
        <p className="mt-1 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "nativeContext.imagesMeasurementHelp" })}
        </p>
      </section>
      {events.length > 0 || unlinked.length > 0 || data?.recordsFailed ? (
        <section className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-ui-base font-medium">
              {intl.formatMessage({ id: "nativeContext.maintenanceEvents" })}
            </h3>
            <Button type="button" variant="ghost" className="min-h-11" onClick={onOpenRecords}>
              {intl.formatMessage({ id: "nativeContext.allRecords" })}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {events.slice(0, 12).map((operation) => (
              <Button
                type="button"
                key={operation.operationId}
                variant="outline"
                className="min-h-11 text-ui-sm"
                onClick={() => onOpenRecord(operation.operationId)}
                data-testid={"native-context-event-" + operation.operationId}
              >
                {intl.formatMessage({ id: "nativeContext.operationKind." + operation.kind })} ·{" "}
                {intl.formatMessage({ id: "nativeContext.operationStatus." + operation.status })}
              </Button>
            ))}
          </div>
          {events.length > 12 || data?.recordsIncomplete ? (
            <p className="text-ui-xs text-foreground-subtle">
              {intl.formatMessage(
                { id: "nativeContext.eventsLoaded" },
                { shown: Math.min(12, events.length), count: events.length },
              )}
            </p>
          ) : null}
          {unlinked.length > 0 ? (
            <details className="rounded-lg border border-border p-2">
              <summary className="flex min-h-11 cursor-pointer items-center text-ui-sm">
                {intl.formatMessage(
                  { id: "nativeContext.unlinkedEvents" },
                  { count: unlinked.length },
                )}
              </summary>
              <p className="mb-2 text-ui-xs text-foreground-subtle">
                {intl.formatMessage({ id: "nativeContext.unlinkedEventsHelp" })}
              </p>
              <div className="flex flex-wrap gap-2">
                {unlinked.slice(0, 12).map((operation) => (
                  <Button
                    type="button"
                    key={operation.operationId}
                    variant="outline"
                    className="min-h-11 text-ui-sm"
                    onClick={() => onOpenRecord(operation.operationId)}
                  >
                    {intl.formatMessage({ id: "nativeContext.operationKind." + operation.kind })} ·{" "}
                    {intl.formatMessage({
                      id: "nativeContext.operationStatus." + operation.status,
                    })}
                  </Button>
                ))}
              </div>
            </details>
          ) : null}
          {data?.recordsFailed ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {intl.formatMessage({ id: "nativeContext.readFailed" })}
            </p>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
