import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { NativeContextOperationDetail, NativeContextReadController } from "../contract.js";
import { formatContextNumber } from "../domain/format.js";
import { assertNativeContextRecordPage } from "../domain/records.js";
import { NativeContextRecordSources } from "./NativeContextRecordSources.js";
import { NativeContextRecordUsage, RecordMetric as Metric } from "./NativeContextRecordUsage.js";

export function NativeContextRecordDetail({
  read,
  operationId,
  onQuote,
}: {
  read: NativeContextReadController;
  operationId: string;
  onQuote: (ref: string, text: string) => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const [operation, setOperation] = useState<NativeContextOperationDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (read.unavailable) return;
    let cancelled = false;
    setFailed(false);
    setOperation(null);
    void read
      .record(operationId, {
        sourceCursor: 0,
        sourceLimit: 20,
        summaryOffset: 0,
        summaryLimitChars: 20000,
      })
      .then((record) => {
        if (!cancelled) setOperation(record);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [operationId, read.record, read.unavailable, retry]);

  if (failed)
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-2 rounded-xl border border-border p-3 text-ui-base text-destructive"
      >
        {intl.formatMessage({ id: "nativeContext.readFailed" })}
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={read.unavailable}
          onClick={() => setRetry((value) => value + 1)}
        >
          {intl.formatMessage({ id: "nativeContext.retry" })}
        </Button>
      </div>
    );
  if (!operation)
    return (
      <p role="status" className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({
          id: read.unavailable ? "nativeContext.offlineHelp" : "nativeContext.loading",
        })}
      </p>
    );

  return (
    <section
      className="rounded-xl border border-border bg-card p-3"
      data-testid="native-context-record-detail"
      data-operation-id={operation.operationId}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-ui-base font-medium">
            {intl.formatMessage({
              id: "nativeContext.operationKind." + operation.kind,
            })}
          </h3>
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({
              id: "nativeContext.trigger." + operation.trigger,
            })}{" "}
            · v{operation.policyVersion} · g{operation.generation}
          </p>
        </div>
        <span className="text-ui-sm">
          {intl.formatMessage({
            id: "nativeContext.operationStatus." + operation.status,
          })}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric
          label={intl.formatMessage({ id: "nativeContext.beforeEstimate" })}
          value={formatContextNumber(operation.beforeEstimate, locale)}
        />
        <Metric
          label={intl.formatMessage({ id: "nativeContext.afterEstimate" })}
          value={formatContextNumber(operation.afterEstimate, locale)}
        />
        <Metric
          label={intl.formatMessage({ id: "nativeContext.elapsed" })}
          value={
            operation.elapsedMs === null
              ? "—"
              : formatContextNumber(operation.elapsedMs, locale) + " ms"
          }
        />
        <Metric
          label={intl.formatMessage({ id: "nativeContext.sources" })}
          value={formatContextNumber(operation.sourceTotal, locale)}
        />
      </div>
      <p className="mt-3 text-ui-sm text-foreground-subtle">
        {intl.formatMessage({
          id:
            operation.kind === "image"
              ? "nativeContext.recordModel"
              : "nativeContext.maintenanceModel",
        })}
        :{" "}
        {operation.model
          ? operation.model.providerId + " / " + operation.model.modelId
          : intl.formatMessage({ id: "nativeContext.noModelRequest" })}
      </p>
      {operation.origin === "inherited" ? (
        <p className="mt-2 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "nativeContext.inheritedHelp" })}
        </p>
      ) : (
        <NativeContextRecordUsage read={read} operation={operation} />
      )}
      {operation.reason && operation.reason !== "none" ? (
        <p className="mt-3 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({
            id: "nativeContext.operationReason." + operation.reason,
          })}
        </p>
      ) : null}
      <RecordSummary read={read} operation={operation} />
      <NativeContextRecordSources read={read} operation={operation} onQuote={onQuote} />
    </section>
  );
}

function RecordSummary({
  read,
  operation,
}: {
  read: NativeContextReadController;
  operation: NativeContextOperationDetail;
}) {
  const { intl, locale } = useZCodeIntl();
  const [text, setText] = useState(operation.summary);
  const [nextOffset, setNextOffset] = useState(operation.nextSummaryOffset);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const requestRef = useRef(0);

  useEffect(
    () => () => {
      requestRef.current += 1;
    },
    [],
  );

  const loadMore = async () => {
    if (nextOffset === null || loading || read.unavailable) return;
    const request = ++requestRef.current;
    setLoading(true);
    setFailed(false);
    try {
      const page = await read.record(operation.operationId, {
        sourceLimit: 1,
        summaryOffset: nextOffset,
        summaryLimitChars: 20000,
      });
      if (request !== requestRef.current) return;
      assertNativeContextRecordPage(operation, page);
      if (
        page.summaryOffset !== text.length ||
        (page.nextSummaryOffset !== null && page.nextSummaryOffset <= nextOffset)
      ) {
        throw new Error("native-context-summary-sequence");
      }
      setText((current) => current + page.summary);
      setNextOffset(page.nextSummaryOffset);
    } catch {
      if (request === requestRef.current) setFailed(true);
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  };

  if (operation.summaryTotalChars === 0)
    return (
      <p className="mt-3 text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "nativeContext.noSummary" })}
      </p>
    );

  return (
    <div className="mt-3 space-y-2">
      <p className="text-ui-xs text-foreground-subtle">
        {intl.formatMessage(
          { id: "nativeContext.summaryLoaded" },
          {
            loaded: formatContextNumber(text.length, locale),
            total: formatContextNumber(operation.summaryTotalChars, locale),
          },
        )}
      </p>
      <div
        className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface p-3 text-ui-base"
        data-testid="native-context-record-summary"
      >
        {text}
      </div>
      {failed ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {intl.formatMessage({ id: "nativeContext.readFailed" })}
        </p>
      ) : null}
      {nextOffset !== null ? (
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={loading || read.unavailable}
          onClick={() => void loadMore()}
          data-testid="native-context-summary-load-more"
        >
          {intl.formatMessage({
            id: loading ? "nativeContext.loading" : "nativeContext.moreSummary",
          })}
        </Button>
      ) : null}
    </div>
  );
}
