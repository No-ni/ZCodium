import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { NativeContextOperationDetail, NativeContextReadController } from "../contract.js";
import { formatContextNumber } from "../domain/format.js";
import { assertNativeContextRecordPage } from "../domain/records.js";
import { NativeContextOriginalSource } from "./NativeContextOriginalSource.js";

export function NativeContextRecordSources({
  read,
  operation,
  onQuote,
}: {
  read: NativeContextReadController;
  operation: NativeContextOperationDetail;
  onQuote: (ref: string, text: string) => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const [page, setPage] = useState({
    sources: operation.sources,
    cursor: 0,
    nextCursor: operation.nextSourceCursor,
  });
  const [previousCursors, setPreviousCursors] = useState<number[]>([]);
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const requestRef = useRef(0);

  useEffect(
    () => () => {
      requestRef.current += 1;
    },
    [],
  );

  const load = async (cursor: number, previous: number[]) => {
    if (loading || read.unavailable) return;
    const request = ++requestRef.current;
    setLoading(true);
    setFailed(false);
    try {
      const result = await read.record(operation.operationId, {
        sourceCursor: cursor,
        sourceLimit: 20,
        summaryLimitChars: 1,
      });
      if (request !== requestRef.current) return;
      assertNativeContextRecordPage(operation, result);
      if (result.nextSourceCursor !== null && result.nextSourceCursor <= cursor) {
        throw new Error("native-context-source-page-sequence");
      }
      setPage({ sources: result.sources, cursor, nextCursor: result.nextSourceCursor });
      setPreviousCursors(previous);
      setSelectedSource(null);
    } catch {
      if (request === requestRef.current) setFailed(true);
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  };

  if (operation.sourceTotal === 0) return null;
  const source = page.sources.find((item) => item.ref === selectedSource);

  return (
    <div className="mt-4 space-y-2">
      <h4 className="text-ui-base font-medium">
        {intl.formatMessage({ id: "nativeContext.sources" })}
      </h4>
      <p className="text-ui-xs text-foreground-subtle" data-testid="native-context-sources-range">
        {intl.formatMessage(
          { id: "nativeContext.sourcesRange" },
          {
            start: formatContextNumber(page.sources.length === 0 ? 0 : page.cursor + 1, locale),
            end: formatContextNumber(page.cursor + page.sources.length, locale),
            total: formatContextNumber(operation.sourceTotal, locale),
          },
        )}
      </p>
      <div className="flex flex-wrap gap-2" aria-busy={loading}>
        {page.sources.map((item, index) => (
          <Button
            type="button"
            key={item.ref + ":" + index}
            variant={selectedSource === item.ref ? "secondary" : "outline"}
            className="min-h-11 text-ui-sm"
            disabled={loading}
            aria-pressed={selectedSource === item.ref}
            onClick={() => setSelectedSource(item.ref)}
            data-testid={"native-context-source-" + item.ref}
          >
            {intl.formatMessage({ id: "nativeContext.sourceKind." + item.kind })}{" "}
            {page.cursor + index + 1}
            {item.originalAvailable
              ? ""
              : " · " + intl.formatMessage({ id: "nativeContext.originalUnavailable" })}
          </Button>
        ))}
      </div>
      {failed ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {intl.formatMessage({ id: "nativeContext.readFailed" })}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={previousCursors.length === 0 || loading || read.unavailable}
          onClick={() => {
            const previous = previousCursors.at(-1);
            if (previous !== undefined) void load(previous, previousCursors.slice(0, -1));
          }}
          data-testid="native-context-sources-previous"
        >
          {intl.formatMessage({ id: "nativeContext.previousPage" })}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={page.nextCursor === null || loading || read.unavailable}
          onClick={() => {
            if (page.nextCursor !== null)
              void load(page.nextCursor, [...previousCursors, page.cursor]);
          }}
          data-testid="native-context-sources-next"
        >
          {intl.formatMessage({ id: loading ? "nativeContext.loading" : "nativeContext.nextPage" })}
        </Button>
      </div>
      {source ? (
        <NativeContextOriginalSource
          key={source.ref}
          read={read}
          source={source}
          onQuote={onQuote}
        />
      ) : null}
    </div>
  );
}
