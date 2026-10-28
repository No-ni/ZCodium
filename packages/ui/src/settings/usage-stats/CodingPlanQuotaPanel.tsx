import { RefreshCcw } from "lucide-react";
import type { CodingPlanQuotaSnapshot } from "@zcode/services";
import type { UsageQuotaLimit } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Progress } from "@/components/ui/progress.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useCodingPlanQuota } from "@/hooks/useCodingPlanQuota.js";
import { formatCompactNumber } from "@/settings/usage-stats/usageStatsUiParts.js";

export function CodingPlanQuotaPanel() {
  const { intl } = useZCodeIntl();
  const quota = useCodingPlanQuota();
  const reason = quota.context?.status === "unavailable" ? quota.context.reason : null;
  const unavailableMessage =
    reason === "missing-api-key"
      ? "apiKeyRequired"
      : reason === "unsupported-provider"
        ? "unsupportedProvider"
        : "noProvider";
  return (
    <section
      className="space-y-3"
      aria-label={intl.formatMessage({ id: "settings.usage.codingPlanQuota.title" })}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.usage.codingPlanQuota.title" })}
        </h3>
        {quota.context?.status === "available" || quota.error ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 bg-background"
            disabled={quota.loading}
            onClick={() => void quota.refresh()}
          >
            <RefreshCcw className="size-3.5" />
            {intl.formatMessage({ id: "settings.usage.refresh" })}
          </Button>
        ) : null}
      </div>
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "settings.usage.codingPlanQuota.description" })}
      </p>
      {quota.error ? (
        <p role="alert" className="text-ui-base text-warning">
          {intl.formatMessage({ id: "settings.usage.codingPlanQuota.error" })}
        </p>
      ) : null}
      {quota.loading && !quota.snapshot ? (
        <p role="status" className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "common.loading" })}
        </p>
      ) : null}
      {quota.snapshot ? <QuotaLimits snapshot={quota.snapshot} /> : null}
      {!quota.loading && !quota.error && reason ? (
        <p className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: `settings.usage.codingPlanQuota.${unavailableMessage}` })}
        </p>
      ) : null}
    </section>
  );
}

function QuotaLimits({ snapshot }: { snapshot: CodingPlanQuotaSnapshot }) {
  const { intl, locale } = useZCodeIntl();
  const limits = snapshot.limits.filter(
    (limit) =>
      limit.remaining !== undefined ||
      limit.percentage !== undefined ||
      (limit.number !== undefined && limit.currentValue !== undefined),
  );
  if (!limits.length)
    return (
      <p className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.usage.codingPlanQuota.empty" })}
      </p>
    );
  return (
    <div className="space-y-3">
      {limits.map((limit, index) => (
        <QuotaLimitRow key={`${limit.type}-${index}`} limit={limit} />
      ))}
      <p className="text-ui-xs text-foreground-subtlest">
        {intl.formatMessage(
          { id: "settings.usage.codingPlanQuota.fetchedAt" },
          { time: formatTime(locale, snapshot.fetchedAt, false) },
        )}
      </p>
    </div>
  );
}

function QuotaLimitRow({ limit }: { limit: UsageQuotaLimit }) {
  const { intl, locale } = useZCodeIntl();
  const labelId =
    limit.type === "TIME_LIMIT"
      ? "windowLimit"
      : limit.type === "TOKENS_LIMIT"
        ? "tokenLimit"
        : "genericLimit";
  const derivedRemaining =
    limit.remaining ??
    (limit.number !== undefined && limit.currentValue !== undefined
      ? Math.max(0, limit.number - limit.currentValue)
      : null);
  // 服务端已使用占比由 Host 归一化；真实 0 不能用真假判断替换成无数据。
  const remainingPercent =
    limit.percentage !== undefined
      ? 1 - limit.percentage
      : derivedRemaining !== null && limit.number !== undefined && limit.number > 0
        ? Math.min(1, derivedRemaining / limit.number)
        : null;
  const remainingValue =
    derivedRemaining !== null
      ? formatCompactNumber(locale, derivedRemaining)
      : remainingPercent !== null && limit.number !== undefined
        ? formatCompactNumber(locale, Math.round(limit.number * remainingPercent))
        : remainingPercent !== null
          ? new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(
              remainingPercent,
            )
          : "--";
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2 text-ui-base">
        <span className="text-foreground-subtle">
          {intl.formatMessage({ id: `settings.usage.codingPlanQuota.${labelId}` })}
        </span>
        <span className="font-medium text-foreground">
          {intl.formatMessage(
            { id: "settings.usage.codingPlanQuota.remainingValue" },
            { value: remainingValue },
          )}
        </span>
      </div>
      {remainingPercent !== null ? (
        <Progress
          value={remainingPercent * 100}
          aria-label={intl.formatMessage({ id: `settings.usage.codingPlanQuota.${labelId}` })}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={remainingPercent * 100}
        />
      ) : null}
      {limit.nextResetTime !== undefined ? (
        <p className="text-ui-xs text-foreground-subtlest">
          {intl.formatMessage(
            { id: "settings.usage.codingPlanQuota.nextReset" },
            { time: formatTime(locale, limit.nextResetTime, true) },
          )}
        </p>
      ) : null}
    </div>
  );
}

function formatTime(locale: string, timestamp: number, includeDay: boolean): string {
  return new Intl.DateTimeFormat(locale, {
    ...(includeDay ? ({ month: "short", day: "numeric" } as const) : {}),
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}
