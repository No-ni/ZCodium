import { Clock, FolderX, MessageCircleOff } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatCountMessage, type summarizeUnusedProjects } from "./project-management-view.js";
export function ProjectManagementSuggestion({
  unused,
  disabled,
  review,
}: {
  unused: ReturnType<typeof summarizeUnusedProjects>;
  disabled: boolean;
  review(): void;
}) {
  const { intl } = useZCodeIntl();
  const count = (id: string, n: number) => formatCountMessage(intl, `projectManagement.${id}`, n);
  const msg = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id: `projectManagement.${id}` }, values);
  return (
    <div
      data-testid="project-management-suggestion"
      className="flex min-w-0 flex-wrap items-center gap-4 rounded-xl border border-card-border bg-card p-4"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="text-ui-base font-medium">{count("suggestion.title", unused.total)}</span>
        <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-ui-sm text-foreground-subtle">
          {(
            [
              ["missing", FolderX],
              ["empty", MessageCircleOff],
              ["idle", Clock],
            ] as const
          ).map(([reason, Icon]) =>
            unused[reason] ? (
              <span key={reason} className="flex items-center gap-1.5">
                <Icon aria-hidden="true" className="size-3.5" />
                {count(`suggestion.${reason}`, unused[reason])}
              </span>
            ) : null,
          )}
        </div>
      </div>
      <Button
        data-testid="project-management-review"
        variant="outline"
        size="lg"
        disabled={disabled}
        onClick={review}
      >
        {msg("review", { count: unused.total })}
      </Button>
    </div>
  );
}
