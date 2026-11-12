import { useEffect, useRef, useState } from "react";
import type { NativeContextRecordSource } from "@zcode/shared/native-context-compression";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  NativeContextImage,
  NativeContextReadController,
  NativeContextSourcePage,
} from "../contract.js";
import { formatContextBytes, formatContextNumber } from "../domain/format.js";

export function NativeContextOriginalSource({
  read,
  source,
  onQuote,
}: {
  read: NativeContextReadController;
  source: NativeContextRecordSource;
  onQuote: (ref: string, text: string) => void;
}) {
  return source.kind === "image" ? (
    <SourceImage read={read} refId={source.ref} available={source.originalAvailable} />
  ) : (
    <SourceText
      read={read}
      refId={source.ref}
      available={source.originalAvailable}
      onQuote={onQuote}
    />
  );
}

function SourceText({
  read,
  refId,
  available,
  onQuote,
}: {
  read: NativeContextReadController;
  refId: string;
  available: boolean;
  onQuote: (ref: string, text: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const [page, setPage] = useState<NativeContextSourcePage | null>(null);
  const [offsets, setOffsets] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [quoted, setQuoted] = useState(false);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const requestRef = useRef(0);

  useEffect(
    () => () => {
      requestRef.current += 1;
    },
    [],
  );

  const load = async (offset = 0, previous: number[] = []) => {
    if (loading || read.unavailable) return;
    const request = ++requestRef.current;
    setLoading(true);
    setFailed(false);
    setQuoted(false);
    try {
      const result = await read.source(refId, offset);
      if (request !== requestRef.current) return;
      setPage(result);
      setOffsets(previous);
    } catch {
      if (request === requestRef.current) setFailed(true);
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  };

  const quote = () => {
    if (!page || !page.originalAvailable || loading || read.unavailable) return;
    const input = textRef.current;
    const selected =
      input && input.selectionEnd > input.selectionStart
        ? page.text.slice(input.selectionStart, input.selectionEnd)
        : page.text;
    onQuote(refId, selected);
    setQuoted(true);
  };

  return (
    <div className="mt-4 space-y-2 rounded-lg border border-border bg-surface p-3">
      <p className="break-all font-mono text-ui-xs text-foreground-subtle">{refId}</p>
      {!available || (page && !page.originalAvailable) ? (
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "nativeContext.originalUnavailableHelp" })}
        </p>
      ) : (
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={loading || read.unavailable}
          onClick={() => void load()}
          data-testid="native-context-read-source"
        >
          {intl.formatMessage({ id: "nativeContext.readSource" })}
        </Button>
      )}
      {loading ? (
        <p role="status" className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "nativeContext.loading" })}
        </p>
      ) : null}
      {failed ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {intl.formatMessage({ id: "nativeContext.readFailed" })}
        </p>
      ) : null}
      {page?.originalAvailable ? (
        <>
          <Textarea
            ref={textRef}
            readOnly
            value={page.text}
            className="max-h-96 min-h-56 overflow-auto font-mono text-ui-caption"
            aria-label={intl.formatMessage({ id: "nativeContext.originalText" })}
            data-testid="native-context-original-text"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={offsets.length === 0 || loading || read.unavailable}
              onClick={() => {
                const previous = offsets.at(-1);
                if (previous !== undefined) void load(previous, offsets.slice(0, -1));
              }}
            >
              {intl.formatMessage({ id: "nativeContext.previousPage" })}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={page.nextOffset === null || loading || read.unavailable}
              onClick={() => {
                if (page.nextOffset !== null) void load(page.nextOffset, [...offsets, page.offset]);
              }}
            >
              {intl.formatMessage({ id: "nativeContext.nextPage" })}
            </Button>
            <Button
              type="button"
              className="min-h-11"
              disabled={!page.text || loading || read.unavailable}
              onClick={quote}
              data-testid="native-context-quote-source"
            >
              {intl.formatMessage({ id: "nativeContext.quoteSource" })}
            </Button>
          </div>
          <p role="status" className="text-ui-xs text-foreground-subtle">
            {intl.formatMessage({
              id: quoted ? "nativeContext.quotedToDraft" : "nativeContext.quoteSourceHelp",
            })}
          </p>
        </>
      ) : null}
    </div>
  );
}

function SourceImage({
  read,
  refId,
  available,
}: {
  read: NativeContextReadController;
  refId: string;
  available: boolean;
}) {
  const { intl, locale } = useZCodeIntl();
  const [image, setImage] = useState<(NativeContextImage & { blob: Blob | null }) | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const requestRef = useRef(0);

  useEffect(
    () => () => {
      requestRef.current += 1;
    },
    [],
  );
  useEffect(() => {
    if (!image?.blob) {
      setObjectUrl(null);
      return;
    }
    const url = URL.createObjectURL(image.blob);
    setObjectUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [image?.blob]);

  const load = async () => {
    if (loading || read.unavailable) return;
    const request = ++requestRef.current;
    setLoading(true);
    setFailed(false);
    try {
      const result = await read.image(refId);
      if (request === requestRef.current) setImage(result);
    } catch {
      if (request === requestRef.current) setFailed(true);
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  };

  return (
    <div className="mt-4 space-y-2 rounded-lg border border-border bg-surface p-3">
      <p className="break-all font-mono text-ui-xs text-foreground-subtle">{refId}</p>
      <Button
        type="button"
        variant="outline"
        className="min-h-11"
        disabled={!available || loading || read.unavailable}
        onClick={() => void load()}
        data-testid="native-context-read-image"
      >
        {intl.formatMessage({ id: "nativeContext.readOriginalImage" })}
      </Button>
      {!available || (image && !image.originalAvailable) ? (
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "nativeContext.originalUnavailableHelp" })}
        </p>
      ) : null}
      {loading ? (
        <p role="status" className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "nativeContext.loading" })}
        </p>
      ) : null}
      {failed ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {intl.formatMessage({ id: "nativeContext.readFailed" })}
        </p>
      ) : null}
      {image?.reason === "capacity" ? (
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "nativeContext.imageCapacity" })}
        </p>
      ) : null}
      {image && (objectUrl || image.dataUrl) ? (
        <>
          <img
            src={objectUrl ?? image.dataUrl ?? undefined}
            alt={intl.formatMessage({ id: "nativeContext.originalImage" })}
            className="max-h-96 w-full object-contain"
            data-testid="native-context-original-image"
          />
          <p className="text-ui-xs text-foreground-subtle">
            {formatContextNumber(image.width, locale)} × {formatContextNumber(image.height, locale)}{" "}
            · {formatContextBytes(image.originalBytes, locale)}
          </p>
        </>
      ) : null}
    </div>
  );
}
