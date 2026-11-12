import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { NativeContextOperationSummary, NativeContextReadController } from "../contract.js";
import { nativeContextVersionKey } from "../domain/format.js";
import { NativeContextRecordDetail } from "./NativeContextRecordDetail.js";

interface RecordData {
  key: string;
  items: NativeContextOperationSummary[];
  nextCursor: number | null;
  loading: boolean;
  failed: boolean;
}

export function NativeContextRecords({
  read,
  selectedOperationId,
  onSelectOperation,
  onQuote,
  onReturnToTrends,
}: {
  read: NativeContextReadController;
  selectedOperationId: string | null;
  onSelectOperation: (id: string) => void;
  onQuote: (ref: string, text: string) => void;
  onReturnToTrends?: () => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const viewKey = read.status
    ? read.scopeKey + ":" + nativeContextVersionKey(read.status)
    : read.scopeKey;
  const [data, setData] = useState<RecordData>({
    key: "",
    items: [],
    nextCursor: null,
    loading: false,
    failed: false,
  });
  const requestRef = useRef(0);
  const [refreshCount, setRefreshCount] = useState(0);
  const owned = data.key === viewKey ? data : null;

  useEffect(() => {
    if (!read.status || read.unavailable) return;
    const request = ++requestRef.current;
    setData({ key: viewKey, items: [], nextCursor: null, loading: true, failed: false });
    void read
      .records({ limit: 50 })
      .then((page) => {
        if (request !== requestRef.current) return;
        setData({
          key: viewKey,
          items: page.items,
          nextCursor: page.nextCursor,
          loading: false,
          failed: false,
        });
      })
      .catch(() => {
        if (request === requestRef.current) {
          setData({ key: viewKey, items: [], nextCursor: null, loading: false, failed: true });
        }
      });
    return () => {
      requestRef.current += 1;
    };
  }, [viewKey, read.records, read.unavailable, refreshCount]);

  const loadMore = async () => {
    if (!owned || owned.nextCursor === null || owned.loading || read.unavailable) return;
    const request = ++requestRef.current;
    setData((current) => ({ ...current, loading: true, failed: false }));
    try {
      const page = await read.records({ cursor: owned.nextCursor, limit: 50 });
      if (request !== requestRef.current) return;
      setData((current) => ({
        ...current,
        items: [
          ...new Map(
            [...current.items, ...page.items].map((item) => [item.operationId, item]),
          ).values(),
        ],
        nextCursor: page.nextCursor,
        loading: false,
      }));
    } catch {
      if (request === requestRef.current) {
        setData((current) => ({ ...current, loading: false, failed: true }));
      }
    }
  };

  return (
    <div className="space-y-4" data-testid="native-context-records">
      {onReturnToTrends ? (
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          onClick={onReturnToTrends}
          data-testid="native-context-return-to-trends"
        >
          ← {intl.formatMessage({ id: "nativeContext.returnToTrends" })}
        </Button>
      ) : null}
      {owned?.failed ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 text-ui-base text-destructive"
        >
          {intl.formatMessage({ id: "nativeContext.readFailed" })}
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={read.unavailable}
            onClick={() => setRefreshCount((value) => value + 1)}
          >
            {intl.formatMessage({ id: "nativeContext.retry" })}
          </Button>
        </div>
      ) : null}
      {owned?.loading && owned.items.length === 0 ? (
        <p role="status" className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "nativeContext.loading" })}
        </p>
      ) : !owned?.failed && (owned?.items.length ?? 0) === 0 ? (
        <p className="rounded-xl border border-border bg-surface p-4 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "nativeContext.noRecords" })}
        </p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {owned?.items.map((operation) => (
            <button
              type="button"
              key={operation.operationId}
              className={
                "min-h-11 rounded-lg border border-border p-3 text-left hover:bg-surface-hover " +
                (selectedOperationId === operation.operationId ? "bg-selected" : "bg-card")
              }
              onClick={() => onSelectOperation(operation.operationId)}
              aria-pressed={selectedOperationId === operation.operationId}
              data-testid={"native-context-record-" + operation.operationId}
            >
              <span className="flex flex-wrap items-center justify-between gap-2 text-ui-base">
                <span className="font-medium">
                  {intl.formatMessage({ id: "nativeContext.operationKind." + operation.kind })}
                </span>
                <span className="text-ui-sm">
                  {intl.formatMessage({ id: "nativeContext.operationStatus." + operation.status })}
                </span>
              </span>
              <span className="mt-1 block text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "nativeContext.trigger." + operation.trigger })} ·{" "}
                {new Date(operation.createdAt).toLocaleString(locale)}
              </span>
              <span className="mt-1 block text-ui-xs text-foreground-subtle">
                v{operation.policyVersion} · g{operation.generation}
                {operation.origin === "inherited"
                  ? " · " + intl.formatMessage({ id: "nativeContext.inherited" })
                  : ""}
              </span>
            </button>
          ))}
        </div>
      )}
      {owned?.nextCursor !== null && owned?.nextCursor !== undefined ? (
        <Button
          type="button"
          variant="outline"
          className="min-h-11 w-full"
          disabled={owned.loading || read.unavailable}
          onClick={() => void loadMore()}
          data-testid="native-context-records-load-more"
        >
          {intl.formatMessage({ id: "nativeContext.loadMore" })}
        </Button>
      ) : null}
      {selectedOperationId ? (
        <NativeContextRecordDetail
          key={viewKey + ":" + selectedOperationId}
          read={read}
          operationId={selectedOperationId}
          onQuote={onQuote}
        />
      ) : null}
    </div>
  );
}
