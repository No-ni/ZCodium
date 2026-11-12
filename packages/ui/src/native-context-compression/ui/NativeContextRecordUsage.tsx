import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  NativeContextObservation,
  NativeContextOperationDetail,
  NativeContextReadController,
} from "../contract.js";
import { formatContextBytes, formatContextNumber } from "../domain/format.js";

/** 详情用量独立拆分以满足模块行数边界，查询版本、取消和重试仍沿原控制器。 */
export function NativeContextRecordUsage({
  read,
  operation,
}: {
  read: NativeContextReadController;
  operation: NativeContextOperationDetail;
}) {
  const { intl, locale } = useZCodeIntl();
  const [observations, setObservations] = useState<NativeContextObservation[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const mainImages = operation.kind === "image";

  useEffect(() => {
    if (read.unavailable || operation.observationIds.length === 0) return;
    let cancelled = false;
    setFailed(false);
    setObservations(null);
    void read
      .observations({ limit: 200, operationId: operation.operationId })
      .then((page) => {
        if (!cancelled) {
          setObservations(
            page.items.filter(
              (item) =>
                operation.observationIds.includes(item.id) &&
                (mainImages ? item.purpose === "main" : item.purpose !== "main"),
            ),
          );
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [operation, mainImages, read.observations, read.unavailable, retry]);

  const usage = (
    key: "actualInputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreateTokens",
  ) => {
    // 没有模型请求才可报真实零；尚无计量事实的维护请求必须保留未知。
    if (operation.observationIds.length === 0) return operation.model === null ? 0 : null;
    if (
      !observations ||
      observations.length !== operation.observationIds.length ||
      observations.some((item) => item[key] === null)
    )
      return null;
    return observations.reduce((sum, item) => sum + (item[key] ?? 0), 0);
  };

  return (
    <>
      <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <RecordMetric
          label={intl.formatMessage({
            id: mainImages ? "nativeContext.actualInput" : "nativeContext.maintenanceInput",
          })}
          value={formatContextNumber(usage("actualInputTokens"), locale)}
        />
        <RecordMetric
          label={intl.formatMessage({
            id: mainImages ? "nativeContext.outputTokens" : "nativeContext.maintenanceOutput",
          })}
          value={formatContextNumber(usage("outputTokens"), locale)}
        />
        <RecordMetric
          label={intl.formatMessage({ id: "nativeContext.cacheRead" })}
          value={formatContextNumber(usage("cacheReadTokens"), locale)}
        />
        <RecordMetric
          label={intl.formatMessage({ id: "nativeContext.cacheCreate" })}
          value={formatContextNumber(usage("cacheCreateTokens"), locale)}
        />
      </div>
      {mainImages ? (
        <ImageRecordFacts observations={observations} expected={operation.observationIds.length} />
      ) : null}
      {failed ? (
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
            onClick={() => setRetry((value) => value + 1)}
          >
            {intl.formatMessage({ id: "nativeContext.retry" })}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function ImageRecordFacts({
  observations,
  expected,
}: {
  observations: NativeContextObservation[] | null;
  expected: number;
}) {
  const { intl, locale } = useZCodeIntl();
  // 图片记录只绑定同次主请求；不把缺失观察或不完整页加成零字节。
  const image = expected === 1 && observations?.length === 1 ? observations[0]!.images : null;
  return (
    <div
      className="mt-3 space-y-2"
      data-testid="native-context-record-image-facts"
      data-before-bytes={String(image?.beforeBytes ?? null)}
      data-after-bytes={String(image?.afterBytes ?? null)}
    >
      <div className="grid grid-cols-2 gap-3">
        <RecordMetric
          label={intl.formatMessage({ id: "nativeContext.sourceBytes" })}
          value={formatContextBytes(image?.beforeBytes ?? null, locale)}
        />
        <RecordMetric
          label={intl.formatMessage({ id: "nativeContext.sentBytes" })}
          value={formatContextBytes(image?.afterBytes ?? null, locale)}
        />
      </div>
      <p className="text-ui-sm text-foreground-subtle">
        {image
          ? intl.formatMessage(
              { id: "nativeContext.requestImages" },
              {
                sent: image.sentCount,
                omitted: image.omittedCount,
                folded: image.foldedCount,
                resized: image.resizedCount,
                restored: image.restoredCount,
                covered: image.sourceCoverage,
                total: image.sourceCount,
              },
            )
          : "—"}
      </p>
      <p className="text-ui-xs text-foreground-subtle">
        {intl.formatMessage({ id: "nativeContext.imageRecordUsageHelp" })}
      </p>
    </div>
  );
}

export function RecordMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-ui-xs text-foreground-subtle">{label}</p>
      <p className="break-words font-mono text-ui-base">{value}</p>
    </div>
  );
}
