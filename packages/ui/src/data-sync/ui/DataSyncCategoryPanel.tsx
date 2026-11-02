import { ArrowRight, Check, ChevronRight, CircleStop, Info } from "lucide-react";
import type { DataSyncBlockedReason } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { DATA_SYNC_CATEGORIES } from "@/data-sync/app/categories.js";
import type { DataSyncCategoryId } from "@/data-sync/contract.js";
import {
  findMissingDataSyncDependencies,
  resolveDataSyncCheckState,
  type DataSyncRow,
  type DataSyncRowStatus,
} from "@/data-sync/domain/compare.js";
import { useDataSyncProviders } from "@/data-sync/app/useDataSyncProviders.js";
import { DataSyncProvidersOverviewRow } from "@/data-sync/ui/DataSyncProvidersPanel.js";
import type { DataSyncCategoryView } from "@/data-sync/app/useDataSyncDialog.js";
import {
  formatItemError,
  formatMissingDependencies,
  formatPushError,
} from "./DataSyncDialogFormatting.js";

type FormatMessage = ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"];

const BLOCKED_REASON_MESSAGE_ID: Record<DataSyncBlockedReason, string> = {
  "size-limit": "remoteSync.blocked.sizeLimit",
  "contains-symlink": "remoteSync.blocked.containsSymlink",
  "target-symlink": "remoteSync.blocked.targetSymlink",
  "compat-directory": "remoteSync.blocked.compatDirectory",
  "external-directory": "remoteSync.blocked.externalDirectory",
  "target-compat-config": "remoteSync.blocked.targetCompatConfig",
  "source-removed": "remoteSync.blocked.sourceRemoved",
  "remote-latest-mismatch": "remoteSync.blocked.remoteLatestMismatch",
  "cross-marketplace-dependency": "remoteSync.blocked.crossMarketplaceDependency",
  "unsupported-source": "remoteSync.blocked.unsupportedSource",
};

// 标签颜色遵循 DESIGN.md 的 *-surface 语义对；「更新」用蓝色的 progress surface，
// 它在四套主题下都保证 4.5:1 对比度（设计稿的 blue-500/15 依赖系统深色媒体查询，切换应用主题时不跟随）。
const BADGE_CLASS: Record<Exclude<DataSyncRowStatus, "blocked">, string> = {
  push: "bg-success-surface text-success-surface-foreground",
  update: "bg-progress-surface text-progress-surface-foreground",
  difference: "bg-warning-surface text-warning-surface-foreground",
  synced: "bg-surface text-foreground-subtle",
};

export function OverviewPanel(props: {
  providers: ReturnType<typeof useDataSyncProviders>;
  views: Readonly<Record<string, DataSyncCategoryView>>;
  disabled: boolean;
  formatMessage: FormatMessage;
  onNavigate(id: "providers" | DataSyncCategoryId): void;
  onSelectionChange(id: DataSyncCategoryId, keys: Iterable<string>): void;
}) {
  const { formatMessage } = props;
  return (
    <div
      data-testid="remote-sync-overview-table"
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-background/50"
    >
      <div className="min-h-0 overflow-y-auto p-2">
        <div className="sticky top-0 z-10 grid grid-cols-[32px_minmax(0,1fr)_64px_64px_minmax(120px,220px)] gap-4 border-b border-border bg-surface px-4 py-3 text-ui-base font-medium text-foreground-subtle">
          <span aria-hidden="true" />
          <span>{formatMessage({ id: "remoteSync.overview.column.category" })}</span>
          <span className="text-center">
            {formatMessage({ id: "remoteSync.overview.column.local" })}
          </span>
          <span className="text-center">
            {formatMessage({ id: "remoteSync.overview.column.remote" })}
          </span>
          <span aria-hidden="true" />
        </div>
        <div className="mt-1 flex flex-col gap-1">
          <DataSyncProvidersOverviewRow
            state={props.providers}
            label={formatMessage({ id: "remoteSync.category.providers" })}
            onNavigate={() => props.onNavigate("providers")}
          />
          {DATA_SYNC_CATEGORIES.map((category) => {
            const view = props.views[category.id];
            if (!view) return null;
            const selectableKeys = view.rows.filter((row) => row.selectable).map((row) => row.key);
            const label = formatMessage({ id: `remoteSync.category.${category.id}` });
            return (
              <div
                key={category.id}
                className="grid grid-cols-[32px_minmax(0,1fr)] items-center gap-4 rounded-lg bg-background px-4 transition-colors hover:bg-surface-hover/50"
              >
                {/* 勾选框与整行跳转分开：点勾选框不进入分类页。 */}
                <Checkbox
                  data-testid={`remote-sync-overview-checkbox-${category.id}`}
                  aria-label={label}
                  checked={resolveDataSyncCheckState(view.rows, view.selected)}
                  disabled={props.disabled || selectableKeys.length === 0}
                  onCheckedChange={(checked) =>
                    props.onSelectionChange(category.id, checked === true ? selectableKeys : [])
                  }
                />
                <button
                  type="button"
                  data-testid={`remote-sync-overview-${category.id}`}
                  onClick={() => props.onNavigate(category.id)}
                  className="grid w-full grid-cols-[minmax(0,1fr)_64px_64px_minmax(120px,220px)] items-center gap-4 py-3 text-left text-ui-base"
                >
                  <span className="truncate font-medium text-foreground">{label}</span>
                  <span
                    data-testid={`remote-sync-overview-local-${category.id}`}
                    className="text-center tabular-nums text-foreground-subtle"
                  >
                    {view.phase === "ready" ? view.localCount : "–"}
                  </span>
                  <span
                    data-testid={`remote-sync-overview-remote-${category.id}`}
                    className="text-center tabular-nums text-foreground-subtle"
                  >
                    {view.phase === "ready" ? view.remoteCount : "–"}
                  </span>
                  <span className="flex min-w-0 items-center justify-end gap-2 text-foreground-subtle">
                    <span className="truncate text-right">
                      {view.phase === "loading"
                        ? formatMessage({ id: "remoteSync.overview.loading" })
                        : view.phase === "error"
                          ? formatMessage({ id: "remoteSync.overview.loadFailed" })
                          : selectableKeys.length === 0 && view.localCount === view.remoteCount
                            ? formatMessage({ id: "remoteSync.difference.matching" })
                            : formatMessage(
                                { id: "remoteSync.difference.changes" },
                                { count: selectableKeys.length },
                              )}
                    </span>
                    <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SelectionBox(props: { checked: boolean; disabled?: boolean }) {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center">
      <span
        className={cn(
          "flex size-4 items-center justify-center rounded-sm border",
          props.checked
            ? "border-primary bg-primary text-primary-foreground"
            : props.disabled
              ? "border-border/50 bg-surface text-transparent"
              : "border-border bg-background text-transparent",
        )}
      >
        <Check className="size-3.5" aria-hidden="true" />
      </span>
    </span>
  );
}

function RowNote(props: { row: DataSyncRow; formatMessage: FormatMessage }) {
  const { note } = props.row;
  if (note.kind === "version") {
    return (
      <span className="flex items-center gap-1 font-mono text-ui-xs text-foreground">
        <span>{note.from}</span>
        <ArrowRight className="size-3 text-foreground-subtle" aria-hidden="true" />
        <span>{note.to}</span>
      </span>
    );
  }
  if (note.kind === "sourceOlder" || note.kind === "contentDiffers") {
    return (
      <span className="text-ui-xs text-foreground">
        {props.formatMessage({
          id:
            note.kind === "sourceOlder"
              ? "remoteSync.version.pushSourceOlder"
              : "remoteSync.version.contentDiffers",
        })}
      </span>
    );
  }
  return null;
}

export function CategoryPanel(props: {
  view: DataSyncCategoryView;
  dependencyTargets: Parameters<typeof findMissingDataSyncDependencies>[1];
  disabled: boolean;
  formatMessage: FormatMessage;
  onSelectionChange(keys: Iterable<string>): void;
  onStop(key: string): void;
}) {
  const { view, formatMessage } = props;
  const selectableKeys = view.rows.filter((row) => row.selectable).map((row) => row.key);
  const allSelected = resolveDataSyncCheckState(view.rows, view.selected) === true;
  return (
    <div
      data-testid="remote-sync-resource-panel"
      className="flex h-full min-h-0 flex-col gap-3 overflow-hidden"
    >
      {view.pushError ? (
        <div
          data-testid="remote-sync-push-error"
          className="flex shrink-0 items-start gap-2 rounded-xl bg-destructive-surface px-3 py-2 text-ui-sm text-destructive-surface-foreground"
        >
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {formatPushError(formatMessage, view.pushError)}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background/50">
        <div className="flex shrink-0 items-center gap-3 border-b border-border bg-surface/50 px-5 py-3">
          <button
            data-testid="remote-sync-select-all"
            type="button"
            role="checkbox"
            aria-checked={allSelected}
            disabled={props.disabled || selectableKeys.length === 0}
            onClick={() => props.onSelectionChange(allSelected ? [] : selectableKeys)}
            className="flex items-center gap-3 text-ui-base text-foreground-subtle hover:text-foreground disabled:opacity-60"
          >
            <SelectionBox checked={allSelected} />
            {formatMessage({ id: "remoteSync.selection.selectAll" })}
          </button>
        </div>
        <div
          data-testid="remote-sync-resource-list"
          className="flex min-h-0 flex-col gap-1 overflow-y-auto p-2"
        >
          {view.phase === "loading" ? (
            <p className="px-3 py-6 text-center text-ui-sm text-foreground-subtle">
              {formatMessage({ id: "remoteSync.overview.loading" })}
            </p>
          ) : view.phase === "error" ? (
            <p className="px-3 py-6 text-center text-ui-sm text-destructive">
              {formatMessage({ id: "remoteSync.category.loadFailed" }, { error: view.error ?? "" })}
            </p>
          ) : view.rows.length === 0 ? (
            <p className="px-3 py-6 text-center text-ui-sm text-foreground-subtle">
              {formatMessage({ id: "remoteSync.category.empty" })}
            </p>
          ) : (
            view.rows.map((row) => {
              const checked = view.selected.has(row.key);
              const rowDisabled = props.disabled || !row.selectable;
              const itemError = view.itemErrors[row.key];
              const missingDependencies = findMissingDataSyncDependencies(
                row.dependencies,
                props.dependencyTargets,
              );
              const stoppable = view.push === "pushing" && view.stoppable.has(row.key);
              const rowButton = (
                <button
                  key={row.key}
                  type="button"
                  role="checkbox"
                  data-testid={`remote-sync-row-${row.key}`}
                  data-sync-key={row.key}
                  data-sync-status={row.status}
                  aria-label={row.name}
                  aria-checked={checked}
                  disabled={rowDisabled}
                  onClick={() => {
                    const next = new Set(view.selected);
                    if (checked) next.delete(row.key);
                    else next.add(row.key);
                    props.onSelectionChange(next);
                  }}
                  className="flex w-full cursor-pointer gap-3 rounded-lg bg-background p-3 text-left transition-colors hover:bg-surface-hover/50 disabled:cursor-default disabled:hover:bg-background"
                >
                  <SelectionBox checked={checked} disabled={!row.selectable} />
                  <span className={cn("min-w-0 flex-1", !row.selectable && "opacity-60")}>
                    <span className="block truncate text-ui-base font-medium text-foreground">
                      {row.name}
                    </span>
                    {/* 说明行不截断：钩子在这里显示完整命令，长路径需要折行。 */}
                    <span className="mt-0.5 block break-words text-ui-sm text-foreground-subtle">
                      {row.note.kind === "blocked"
                        ? formatMessage({ id: BLOCKED_REASON_MESSAGE_ID[row.note.reason] })
                        : (row.description ?? "")}
                    </span>
                    {missingDependencies ? (
                      <span
                        data-testid={`remote-sync-row-hint-${row.key}`}
                        className="mt-0.5 block text-ui-sm text-warning-surface-foreground"
                      >
                        {formatMissingDependencies(formatMessage, missingDependencies)}
                      </span>
                    ) : null}
                    {itemError ? (
                      <span
                        data-testid={`remote-sync-row-error-${row.key}`}
                        className="mt-0.5 block text-ui-sm text-destructive"
                      >
                        {formatItemError(formatMessage, itemError)}
                      </span>
                    ) : null}
                  </span>
                  <span
                    data-testid={`remote-sync-difference-${row.key}`}
                    className="mt-0.5 flex shrink-0 items-center gap-2 self-start"
                  >
                    <RowNote row={row} formatMessage={formatMessage} />
                    {row.status !== "blocked" ? (
                      <span
                        className={cn(
                          "shrink-0 rounded-full px-2 py-0.5 text-ui-xs",
                          BADGE_CLASS[row.status],
                        )}
                      >
                        {formatMessage({ id: `remoteSync.operation.${row.status}` })}
                      </span>
                    ) : null}
                  </span>
                </button>
              );
              if (!stoppable) return rowButton;
              // 远端 add / install 期间该行可单独「停止」；按钮放在行外，避免嵌套在行按钮里。
              return (
                <div key={row.key} className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">{rowButton}</div>
                  <Button
                    type="button"
                    data-testid={`remote-sync-row-stop-${row.key}`}
                    variant="secondary"
                    size="sm"
                    className="mr-2 shrink-0"
                    onClick={() => props.onStop(row.key)}
                  >
                    <CircleStop aria-hidden="true" />
                    {formatMessage({ id: "remoteSync.action.stop" })}
                  </Button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
