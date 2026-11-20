import { useMemo } from "react";
import { Globe, LoaderCircle, RefreshCw, TriangleAlertIcon, X } from "lucide-react";
import {
  TID_BROWSER_LOAD_ERROR,
  TID_BROWSER_LOAD_ERROR_CERT_HINT,
  TID_BROWSER_RECENT_VISITS,
} from "@zcode/shared/test-ids";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { BrowserVisitRecord } from "@/store/browserRecentVisitsStore.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { type BrowserGuestFailure, type BrowserState } from "@/embeddedBrowserHelpers.js";

export function BrowserEmptyState({
  browserState,
  formatMessage,
  isGuestStarting = !browserState.isReady,
  visits = [],
  onOpenRecentVisit,
  onRemoveRecentVisit,
}: {
  browserState: BrowserState;
  formatMessage: (descriptor: { id: string }) => string;
  isGuestStarting?: boolean;
  visits?: BrowserVisitRecord[];
  onOpenRecentVisit?: (url: string) => void;
  onRemoveRecentVisit?: (url: string) => void;
}) {
  if (visits.length > 0 && onOpenRecentVisit && !isGuestStarting) {
    return (
      <BrowserRecentVisits
        formatMessage={formatMessage}
        onOpen={onOpenRecentVisit}
        onRemove={onRemoveRecentVisit}
        visits={visits}
      />
    );
  }

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-background px-6">
      <div className="flex max-w-sm flex-col pb-10 items-center text-center">
        {isGuestStarting ? (
          <LoaderCircle className="mb-6 size-16 animate-spin text-foreground opacity-30" />
        ) : (
          <Globe className="mb-6 size-16 text-foreground opacity-30" />
        )}
        <h3 className="text-ui-base font-medium text-foreground">
          {formatMessage({ id: "browser.title" })}
        </h3>
        <p className="mt-2 text-ui-base text-foreground-subtle">
          {formatMessage({ id: "browser.empty" })}
        </p>
      </div>
    </div>
  );
}

function BrowserRecentVisits({
  formatMessage,
  onOpen,
  onRemove,
  visits,
}: {
  formatMessage: (descriptor: { id: string }) => string;
  onOpen: (url: string) => void;
  onRemove?: (url: string) => void;
  visits: BrowserVisitRecord[];
}) {
  const { locale } = useZCodeIntl();
  const timeFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }),
    [locale],
  );
  return (
    <section
      aria-label={formatMessage({ id: "browser.recentVisits.title" })}
      data-testid={TID_BROWSER_RECENT_VISITS}
      className="absolute inset-0 z-10 overflow-y-auto bg-background px-4 py-5 sm:px-6"
    >
      <div
        data-testid="browser-recent-visits-content"
        className="absolute top-[40%] left-1/2 max-h-[calc(80%_-_40px)] w-[calc(100%_-_32px)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto sm:w-[calc(100%_-_48px)]"
      >
        <h2 className="mb-3 text-center text-ui-base font-medium text-foreground">
          {formatMessage({ id: "browser.recentVisits.title" })}
        </h2>
        <ul className="divide-y divide-border">
          {visits.map((visit) => (
            <li key={visit.url} className="flex min-w-0 items-center gap-1">
              <button
                type="button"
                data-browser-recent-url={visit.url}
                title={visit.url}
                onClick={() => onOpen(visit.url)}
                className="flex min-w-0 flex-1 items-center gap-3 px-2 py-3 text-left hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand"
              >
                {visit.faviconUrl ? (
                  <img
                    alt=""
                    src={visit.faviconUrl}
                    className="size-5 shrink-0 rounded-sm object-contain"
                    onError={(event) => {
                      event.currentTarget.hidden = true;
                    }}
                  />
                ) : (
                  <Globe aria-hidden="true" className="size-5 shrink-0 text-foreground-subtle" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center justify-between gap-3">
                    <span className="truncate text-ui-base font-medium text-foreground">
                      {visit.title || visit.url}
                    </span>
                    <time
                      dateTime={new Date(visit.lastVisitedAt).toISOString()}
                      className="shrink-0 text-ui-xs text-foreground-subtle"
                    >
                      {timeFormatter.format(visit.lastVisitedAt)}
                    </time>
                  </span>
                  <span className="block truncate text-ui-sm text-foreground-subtle">
                    {visit.url}
                  </span>
                </span>
              </button>
              {onRemove ? (
                <ControlHintTooltip title={formatMessage({ id: "browser.recentVisits.remove" })}>
                  <Button
                    type="button"
                    size="icon-md"
                    variant="ghost"
                    aria-label={formatMessage({ id: "browser.recentVisits.remove" })}
                    data-browser-recent-remove-url={visit.url}
                    className="mr-1 text-foreground-subtle"
                    onClick={() => onRemove(visit.url)}
                  >
                    <X aria-hidden="true" className="size-4" />
                  </Button>
                </ControlHintTooltip>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/**
 * 页面加载失败时的可读错误态。
 *
 * Electron 的 `<webview>` 不带 Chrome 的安全插页，被拒的导航只落到一张空的
 * chrome-error 页；过去 errorMessage 只写进 state 没有渲染消费者，空置态又同时被关掉，
 * 用户最终只看到纯黑。证书类失败额外给出放行指引，避免用户无从下手。
 */
export function BrowserLoadErrorState({
  errorMessage,
  formatMessage,
  isCertificateError,
  onRetry,
}: {
  errorMessage: string;
  formatMessage: (descriptor: { id: string }, values?: Record<string, number | string>) => string;
  isCertificateError: boolean;
  onRetry: () => void;
}) {
  return (
    <div
      data-testid={TID_BROWSER_LOAD_ERROR}
      className="absolute inset-0 z-10 flex items-center justify-center bg-background px-6"
    >
      <div className="flex max-w-sm flex-col items-center pb-10 text-center">
        <TriangleAlertIcon className="mb-6 size-16 text-warning opacity-60" />
        <h3 className="text-ui-base font-medium text-foreground">
          {formatMessage({
            id: isCertificateError ? "browser.loadError.certTitle" : "browser.loadError.title",
          })}
        </h3>
        <p className="mt-2 font-mono text-ui-sm break-all text-foreground-subtlest">
          {errorMessage}
        </p>
        {isCertificateError ? (
          <p
            data-testid={TID_BROWSER_LOAD_ERROR_CERT_HINT}
            className="mt-3 text-ui-base text-foreground-subtle"
          >
            {formatMessage({ id: "browser.loadError.certHint" })}
          </p>
        ) : null}
        <Button type="button" variant="outline" className="mt-6" onClick={onRetry}>
          <RefreshCw className="size-4" />
          {formatMessage({ id: "browser.loadError.retry" })}
        </Button>
      </div>
    </div>
  );
}

/** guest 启动失败时由宿主接管画面；自动重建会形成失败循环，因此只提供显式重试。 */
export function BrowserGuestFailureState({
  formatMessage,
  guestFailure,
  onRetry,
}: {
  formatMessage: (descriptor: { id: string }, values?: Record<string, number | string>) => string;
  guestFailure: BrowserGuestFailure;
  onRetry: () => void;
}) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-background px-6">
      <div className="flex max-w-sm flex-col items-center pb-10 text-center">
        <TriangleAlertIcon className="mb-6 size-16 text-warning opacity-60" />
        <h3 className="text-ui-base font-medium text-foreground">
          {formatMessage({ id: "browser.guestFailed.title" })}
        </h3>
        <p className="mt-2 text-ui-base text-foreground-subtle">
          {formatMessage({ id: "browser.guestFailed.description" })}
        </p>
        <p className="mt-2 font-mono text-ui-sm text-foreground-subtlest">
          {formatMessage(
            { id: "browser.guestFailed.detail" },
            { exitCode: guestFailure.exitCode, reason: guestFailure.reason },
          )}
        </p>
        <Button type="button" variant="outline" className="mt-6" onClick={onRetry}>
          <RefreshCw className="size-4" />
          {formatMessage({ id: "browser.guestFailed.retry" })}
        </Button>
      </div>
    </div>
  );
}
export { BrowserRecentVisits };
