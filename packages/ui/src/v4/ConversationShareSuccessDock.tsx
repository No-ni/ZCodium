import { CheckCircle2, X } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ConversationShareDisplayWarnings } from "@/store/conversationShareSelectionStore.js";
import {
  formatConversationShareAllowedArtifacts,
  formatConversationShareArtifactType,
  resolveConversationShareWarningMessageId,
} from "@/lib/conversationShareError.js";

export interface ConversationShareSuccessDockProps {
  title: string;
  warnings?: ConversationShareDisplayWarnings | null;
  downloadStarted?: boolean;
  onDismiss: () => void;
}

function formatValue(value: number | undefined, code: string): string {
  if (value === undefined) return "—";
  if (code.includes("size") || code === "payload_size_limit") {
    if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    if (value >= 1024) return `${Math.round(value / 1024)} KB`;
    return `${value} B`;
  }
  return String(value);
}

export function ConversationShareSuccessDock({
  title,
  warnings = null,
  downloadStarted = false,
  onDismiss,
}: ConversationShareSuccessDockProps) {
  const { intl, locale } = useZCodeIntl();

  return (
    // 分享 dock 曾在同一输入区额外叠加 popover ring、阴影和固定宽度，
    // 切换时会产生不必要的层级光晕；这里只继承普通 Composer 的基础输入 surface。
    <section
      data-conversation-share-keep-open="success-dock"
      data-testid="conversation-share-success-dock"
      className={cn("w-full overflow-hidden text-foreground", "flex flex-col gap-3 bg-popover p-3")}
    >
      <div className={cn("flex justify-between gap-3", "items-center")}>
        <div
          data-testid="conversation-share-success-status"
          role="status"
          aria-live="polite"
          className={cn("flex min-w-0 gap-2", "items-center")}
        >
          <CheckCircle2 className={"size-4 shrink-0 text-success"} aria-hidden="true" />
          <div className="min-w-0">
            <p className={cn("font-medium text-foreground", "text-ui-lg")}>
              {intl.formatMessage({
                id: downloadStarted
                  ? "conversationShare.export.downloadStarted"
                  : "conversationShare.result.title",
              })}
            </p>
            {null}
          </div>
        </div>
        <button
          type="button"
          data-testid="conversation-share-success-dismiss"
          aria-label={intl.formatMessage({
            id: "conversationShare.result.dismiss",
          })}
          onClick={onDismiss}
          className="flex size-7 shrink-0 items-center justify-center rounded-lg text-foreground-subtle outline-none transition-colors hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-input-border-focused"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>

      <div className={"grid gap-1"}>
        {null}
        <p
          data-testid="conversation-share-result-title"
          className={cn("min-w-0 text-ui-base text-foreground", "line-clamp-2 break-words")}
          title={title}
        >
          {title}
        </p>
      </div>

      {warnings && warnings.issues.length > 0 ? (
        <details
          data-testid="conversation-share-success-warning"
          className={cn(
            "rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-foreground",
          )}
        >
          <summary className="cursor-pointer text-ui-base font-medium text-warning">
            {intl.formatMessage(
              { id: "conversationShare.warning.summary" },
              { count: warnings.issueCount },
            )}
          </summary>
          <ul className="mt-2 grid gap-1.5 text-ui-base leading-normal">
            {warnings.issues.map((issue, index) => (
              <li key={`${issue.code}-${issue.rowId ?? "global"}-${index}`}>
                {intl.formatMessage(
                  { id: resolveConversationShareWarningMessageId(issue) },
                  {
                    turnOrdinal: issue.turnOrdinal ?? "—",
                    artifactDisplayName: issue.artifactDisplayName ?? "—",
                    artifactType: formatConversationShareArtifactType(issue, locale),
                    extension: issue.extension ?? "—",
                    mimeType: issue.mimeType ?? "—",
                    allowedFormats: formatConversationShareAllowedArtifacts(issue, locale),
                    actual: formatValue(issue.actual, issue.code),
                    limit: formatValue(issue.limit, issue.code),
                    phase: issue.phase ?? "—",
                  },
                )}
              </li>
            ))}
          </ul>
          {warnings.omittedIssueCount ? (
            <p className="mt-2 text-ui-sm text-foreground-subtle">
              {intl.formatMessage(
                { id: "conversationShare.issue.more" },
                { count: warnings.omittedIssueCount },
              )}
            </p>
          ) : null}
        </details>
      ) : null}

      {/* 本地归档返回文件名与下载结果，没有官方分享 URL 或浏览器续聊入口。 */}
      <div data-testid="conversation-share-success-actions" className="flex justify-end">
        <Button type="button" size="lg" onClick={onDismiss}>
          {intl.formatMessage({ id: "common.close" })}
        </Button>
      </div>
    </section>
  );
}
