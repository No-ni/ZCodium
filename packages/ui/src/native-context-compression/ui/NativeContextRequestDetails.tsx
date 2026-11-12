import { nativeContextCacheHitPercent } from "@zcode/shared/native-context-compression";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { NativeContextObservation, NativeContextOperationSummary } from "../contract.js";
import {
  formatContextBytes,
  formatContextNumber,
  nativeContextRequestSaving,
} from "../domain/format.js";
import { summarizeNativeContextUsage } from "../domain/usage.js";

export function NativeContextRequestDetails({
  observation,
  operations,
  maintenance,
  hiddenSeries,
  onOpenRecord,
  onParameters,
}: {
  observation: NativeContextObservation;
  operations: readonly NativeContextOperationSummary[];
  maintenance: readonly NativeContextObservation[];
  hiddenSeries: readonly string[];
  onOpenRecord: (operationId: string) => void;
  onParameters: () => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const saving = nativeContextRequestSaving(observation);
  const hit = nativeContextCacheHitPercent(observation);
  const cells = [
    {
      key: "beforeEstimate",
      value: formatContextNumber(observation.beforeEstimate, locale),
      series: "native-context-input-chart:before",
    },
    {
      key: "afterEstimate",
      value: formatContextNumber(observation.afterEstimate, locale),
      series: "native-context-input-chart:after",
    },
    {
      key: "actualInput",
      value: formatContextNumber(observation.actualInputTokens, locale),
      series: "native-context-input-chart:actual",
    },
    { key: "outputTokens", value: formatContextNumber(observation.outputTokens, locale) },
    {
      key: "inputBudget",
      value: formatContextNumber(observation.inputBudget, locale),
      series: "native-context-input-chart:budget",
    },
    {
      key: "startThreshold",
      value: formatContextNumber(observation.startTokens, locale),
      series: "native-context-input-chart:start",
    },
    {
      key: "targetThreshold",
      value: formatContextNumber(observation.targetTokens, locale),
      series: "native-context-input-chart:target",
    },
    {
      key: "cacheHit",
      value:
        hit === null
          ? "—"
          : new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(hit) + "%",
      series: "native-context-cache-chart:hit",
    },
    {
      key: "cacheRead",
      value: formatContextNumber(observation.cacheReadTokens, locale),
      series: "native-context-cache-chart:read",
    },
    {
      key: "cacheCreate",
      value: formatContextNumber(observation.cacheCreateTokens, locale),
      series: "native-context-cache-chart:create",
    },
    {
      key: "sourceBytes",
      value: formatContextBytes(
        observation.images.sourceCoverage === observation.images.sourceCount
          ? observation.images.beforeBytes
          : null,
        locale,
      ),
      series: "native-context-image-chart:before",
    },
    {
      key: "sentBytes",
      value: formatContextBytes(observation.images.afterBytes, locale),
      series: "native-context-image-chart:after",
    },
    { key: "visionTokens", value: formatContextNumber(observation.visionTokens, locale) },
  ];
  const visibleCells = cells.filter((cell) => !cell.series || !hiddenSeries.includes(cell.series));

  return (
    <div
      className="rounded-xl border border-border bg-card p-3"
      data-testid="native-context-request-details"
      data-observation-id={observation.id}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-ui-base font-medium">
            {intl.formatMessage(
              { id: "nativeContext.requestNumber" },
              { request: observation.requestSeq },
            )}
          </h3>
          <p className="text-ui-sm text-foreground-subtle">
            {observation.model.providerId} / {observation.model.modelId} · v
            {observation.policyVersion} · g{observation.generation}
          </p>
          <p className="text-ui-xs text-foreground-subtle">
            {new Date(observation.createdAt).toLocaleString(locale)} ·{" "}
            {intl.formatMessage(
              { id: "nativeContext.attempt" },
              { attempt: observation.attemptIndex + 1 },
            )}
            {observation.origin === "inherited"
              ? " · " + intl.formatMessage({ id: "nativeContext.inherited" })
              : ""}
          </p>
        </div>
        <span className="text-ui-sm">
          {intl.formatMessage({ id: "nativeContext.requestStatus." + observation.status })}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {visibleCells.map((cell) => (
          <div
            key={cell.key}
            className="min-w-0"
            data-testid={"native-context-request-metric-" + cell.key}
          >
            <p className="text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: "nativeContext." + cell.key })}
            </p>
            <p className="break-words font-mono text-ui-base">{cell.value}</p>
          </div>
        ))}
      </div>
      <p className="mt-3 text-ui-sm">
        {intl.formatMessage(
          {
            id:
              saving !== null && saving < 0
                ? "nativeContext.inputIncrease"
                : "nativeContext.requestSaving",
          },
          {
            tokens: formatContextNumber(saving === null ? null : Math.abs(saving), locale),
          },
        )}
      </p>
      <p className="mt-1 text-ui-sm text-foreground-subtle">
        {intl.formatMessage({
          id: "nativeContext.measurementScope." + observation.measurementScope,
        })}
      </p>
      {observation.measurementScope !== "complete" ? (
        <p className="mt-1 text-ui-sm text-foreground-subtle">
          {intl.formatMessage(
            { id: "nativeContext.textEstimate" },
            {
              before: formatContextNumber(observation.textBeforeEstimate, locale),
              after: formatContextNumber(observation.textAfterEstimate, locale),
            },
          )}
        </p>
      ) : null}
      <p className="mt-1 text-ui-sm text-foreground-subtle">
        {observation.images.sourceCount === 0 && observation.images.sentCount === 0
          ? intl.formatMessage({ id: "nativeContext.noImages" })
          : intl.formatMessage(
              { id: "nativeContext.requestImages" },
              {
                sent: observation.images.sentCount,
                omitted: observation.images.omittedCount,
                restored: observation.images.restoredCount,
                folded: observation.images.foldedCount,
                resized: observation.images.resizedCount,
                covered: observation.images.sourceCoverage,
                total: observation.images.sourceCount,
              },
            )}
      </p>
      {observation.operationIds.length > 0 ? (
        <div className="mt-3 space-y-2">
          {observation.operationIds.map((id, index) => (
            <RequestOperation
              key={id}
              operation={operations.find((item) => item.operationId === id)}
              operationId={id}
              index={index}
              maintenance={maintenance}
              onOpenRecord={onOpenRecord}
            />
          ))}
        </div>
      ) : null}
      <Button type="button" variant="ghost" className="mt-2 min-h-11" onClick={onParameters}>
        {intl.formatMessage({ id: "nativeContext.adjustParameters" })}
      </Button>
    </div>
  );
}

function RequestOperation({
  operation,
  operationId,
  index,
  maintenance,
  onOpenRecord,
}: {
  operation: NativeContextOperationSummary | undefined;
  operationId: string;
  index: number;
  maintenance: readonly NativeContextObservation[];
  onOpenRecord: (operationId: string) => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const observations = operation
    ? maintenance.filter((item) => operation.observationIds.includes(item.id))
    : [];
  const complete =
    operation &&
    (operation.observationIds.length === 0
      ? operation.model === null
      : observations.length === operation.observationIds.length);
  const input = complete ? summarizeNativeContextUsage(observations, "actualInputTokens") : null;
  const output = complete ? summarizeNativeContextUsage(observations, "outputTokens") : null;
  return (
    <div className="rounded-lg border border-border bg-surface p-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-ui-sm">
          {operation
            ? intl.formatMessage({ id: "nativeContext.operationKind." + operation.kind })
            : intl.formatMessage({ id: "nativeContext.viewOperation" }, { index: index + 1 })}
          {operation
            ? " · " +
              intl.formatMessage({ id: "nativeContext.operationStatus." + operation.status })
            : ""}
        </span>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 text-ui-sm"
          onClick={() => onOpenRecord(operationId)}
          data-testid={"native-context-request-operation-" + operationId}
        >
          {intl.formatMessage({ id: "nativeContext.viewRecord" })}
        </Button>
      </div>
      {operation ? (
        <p className="mt-1 text-ui-xs text-foreground-subtle">
          {operation.origin === "inherited"
            ? intl.formatMessage({ id: "nativeContext.inheritedHelp" })
            : operation.model === null && operation.observationIds.length === 0
              ? intl.formatMessage({ id: "nativeContext.noModelRequest" })
              : intl.formatMessage(
                  { id: "nativeContext.operationUsage" },
                  {
                    input: formatContextNumber(input?.value, locale),
                    output: formatContextNumber(output?.value, locale),
                    unknown: Math.max(input?.unknown ?? 0, output?.unknown ?? 0),
                  },
                )}
          {" · " + intl.formatMessage({ id: "nativeContext.elapsed" }) + ": "}
          {operation.elapsedMs === null
            ? "—"
            : formatContextNumber(operation.elapsedMs, locale) + " ms"}
          {operation.model
            ? " · " + operation.model.providerId + " / " + operation.model.modelId
            : ""}
        </p>
      ) : null}
    </div>
  );
}
