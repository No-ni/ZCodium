import { useMemo, useState } from "react";
import { Check, CloudOff, Package, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  DATA_SYNC_CATEGORIES,
  DATA_SYNC_OVERVIEW_ICON,
  type DataSyncCategoryAdapter,
} from "@/data-sync/app/categories.js";
import type { DataSyncCategoryId, DataSyncDialogProps } from "@/data-sync/contract.js";
import { createPluginSyncResultReporter } from "@/data-sync/app/marketplacePluginSync.js";
import type { DataSyncDependencyKeys } from "@/data-sync/domain/compare.js";
import { useDataSyncProviders } from "@/data-sync/app/useDataSyncProviders.js";
import { DataSyncProvidersPanel } from "@/data-sync/ui/DataSyncProvidersPanel.js";
import { useDataSyncDialog, type DataSyncCategoryView } from "@/data-sync/app/useDataSyncDialog.js";
import { CategoryPanel, OverviewPanel } from "./DataSyncCategoryPanel.js";

// 模型提供商是只读分类，不是 IDataSyncCategoryService：不参与勾选与「推送全部」，单独渲染。
type ActiveTab = "overview" | "providers" | DataSyncCategoryId;
type FormatMessage = ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"];

/** 依赖提示的两端列表：只用已就绪分类的最近一次加载结果，推送后刷新完成即随之更新。 */
function readyDependencyKeys(
  view: DataSyncCategoryView | undefined,
): DataSyncDependencyKeys | undefined {
  return view?.phase === "ready" ? { source: view.sourceKeys, target: view.targetKeys } : undefined;
}

export function DataSyncDialog(props: DataSyncDialogProps) {
  const { intl } = useZCodeIntl();
  const [activeTab, setActiveTab] = useState<ActiveTab>(props.initialCategory ?? "overview");
  const remoteKind = props.device.remoteKind;
  const reportPluginSyncResult = useMemo(
    () => createPluginSyncResultReporter(remoteKind),
    [remoteKind],
  );
  const state = useDataSyncDialog({
    categories: DATA_SYNC_CATEGORIES,
    sourceServerId: props.device.sourceServerId,
    sourceServices: props.sourceServices,
    targetServices: props.targetServices,
    online: props.online,
    workspaceHistory: props.workspaceHistory,
    workspaceTabs: props.workspaceTabs,
    workspace: props.workspace,
    onPushFinished: props.onPushFinished,
    reportPluginSyncResult,
  });
  const providers = useDataSyncProviders({
    sourceServices: props.sourceServices,
    sourceServerId: props.device.sourceServerId,
    online: props.online,
  });
  const activeCategory = DATA_SYNC_CATEGORIES.find((category) => category.id === activeTab);
  const activeView = activeCategory ? state.views[activeCategory.id] : undefined;
  const disabled = !state.connected || state.pushing;
  const offline = !props.online;
  // 推送中禁止关闭弹窗；没有全局取消，结果完整返回后才能关闭。
  const blockClose = (event: Event) => {
    if (state.pushing) event.preventDefault();
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open && state.pushing) return;
        props.onOpenChange(open);
      }}
    >
      <DialogContent
        data-testid="remote-sync-dialog"
        className="h-[calc(100vh-6rem)] max-h-168 max-w-4xl overflow-hidden rounded-2xl p-0 max-md:h-[calc(100dvh-2rem)] max-md:max-h-[calc(100dvh-2rem)]"
        showCloseButton={!state.pushing}
        onEscapeKeyDown={blockClose}
        onInteractOutside={blockClose}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{intl.formatMessage({ id: "remoteSync.dialog.title" })}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "remoteSync.overview.description" })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex h-full min-h-0 min-w-0 flex-col md:flex-row">
          <aside className="flex shrink-0 flex-col gap-2 p-1 md:w-56">
            <div
              data-testid="remote-sync-sidebar-frame"
              className="flex flex-col gap-3 border-border bg-surface p-3 max-md:border-b md:h-full md:gap-4 md:rounded-xl md:border md:p-4"
            >
              <div className="hidden text-ui-base font-medium uppercase tracking-wide text-foreground-subtle md:block">
                {intl.formatMessage({ id: "remoteSync.dialog.categories" })}
              </div>
              {/* 窄窗口下分类变为顶部横向滚动标签。 */}
              <nav
                className="flex gap-2 overflow-x-auto md:flex-col"
                aria-label={intl.formatMessage({ id: "remoteSync.dialog.categories" })}
              >
                {[
                  { id: "overview" as const, icon: DATA_SYNC_OVERVIEW_ICON },
                  { id: "providers" as const, icon: Package },
                  ...DATA_SYNC_CATEGORIES,
                ].map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      data-testid={`remote-sync-tab-${item.id}`}
                      aria-current={activeTab === item.id ? "page" : undefined}
                      onClick={() => setActiveTab(item.id)}
                      className={cn(
                        "flex shrink-0 items-center gap-3 rounded-xl px-3 py-3 text-ui-base font-medium transition-colors md:w-full",
                        activeTab === item.id
                          ? "bg-card text-foreground"
                          : "text-foreground-subtle hover:bg-background-alt hover:text-foreground",
                      )}
                    >
                      <Icon className="size-4 shrink-0" aria-hidden="true" />
                      {intl.formatMessage({ id: `remoteSync.category.${item.id}` })}
                    </button>
                  );
                })}
              </nav>
            </div>
          </aside>
          <section
            data-testid="remote-sync-dialog-main"
            className="flex min-h-0 min-w-0 flex-1 flex-col gap-5 overflow-hidden p-4 md:p-6"
          >
            <div className="shrink-0 pr-8">
              <h3 className="text-ui-lg font-medium text-foreground">
                {intl.formatMessage({ id: `remoteSync.category.${activeTab}` })}
              </h3>
              <div
                data-testid="remote-sync-dialog-device"
                className="mt-2 flex min-w-0 items-center gap-2 text-ui-base text-foreground-subtle"
              >
                <span
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    offline ? "border border-foreground-subtlest" : "bg-success",
                  )}
                  aria-hidden="true"
                />
                <span className="truncate">{props.device.name}</span>
                <span className="text-foreground-subtlest">·</span>
                <span className="truncate">{props.device.description}</span>
              </div>
            </div>
            {offline ? (
              <div
                data-testid="remote-sync-offline"
                className="flex shrink-0 items-start gap-2 rounded-xl border border-border px-3 py-2 text-ui-sm text-foreground-subtle"
              >
                <CloudOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                {intl.formatMessage({ id: "remoteSync.dialog.offline" })}
              </div>
            ) : null}
            <div className="min-h-0 flex-1 overflow-hidden">
              {activeTab === "providers" ? (
                <DataSyncProvidersPanel state={providers} disabled={offline} />
              ) : activeCategory && activeView ? (
                <CategoryPanel
                  key={activeCategory.id}
                  view={activeView}
                  dependencyTargets={{
                    mcp: readyDependencyKeys(state.views.mcp),
                    skills: readyDependencyKeys(state.views.skills),
                  }}
                  disabled={disabled}
                  formatMessage={intl.formatMessage}
                  onSelectionChange={(keys) => state.setSelection(activeCategory.id, keys)}
                  onStop={(key) => state.stopItem(activeCategory.id, key)}
                />
              ) : (
                <OverviewPanel
                  providers={providers}
                  views={state.views}
                  disabled={disabled}
                  formatMessage={intl.formatMessage}
                  onNavigate={setActiveTab}
                  onSelectionChange={state.setSelection}
                />
              )}
            </div>
            <DialogFooterBar
              providersTab={activeTab === "providers"}
              activeCategory={activeCategory}
              activeView={activeView}
              offline={!state.connected}
              pushing={state.pushing}
              pushAllState={state.pushAllState}
              hasOverviewSelection={Object.values(state.views).some(
                (view) => view.selected.size > 0,
              )}
              formatMessage={intl.formatMessage}
              onClose={() => props.onOpenChange(false)}
              onClear={(id) => state.setSelection(id, [])}
              onPushCategory={state.pushCategory}
              onPushAll={state.pushAll}
            />
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DialogFooterBar(props: {
  providersTab: boolean;
  activeCategory: DataSyncCategoryAdapter | undefined;
  activeView: DataSyncCategoryView | undefined;
  offline: boolean;
  pushing: boolean;
  pushAllState: "idle" | "pushing" | "done";
  hasOverviewSelection: boolean;
  formatMessage: FormatMessage;
  onClose(): void;
  onClear(id: DataSyncCategoryId): void;
  onPushCategory(id: DataSyncCategoryId): void;
  onPushAll(): void;
}) {
  const { activeCategory, activeView, formatMessage } = props;
  if (props.providersTab) {
    // 模型提供商只读：没有推送按钮，也不参与「推送全部」。
    return (
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
        {!props.pushing ? (
          <Button
            type="button"
            data-testid="remote-sync-close"
            variant="secondary"
            size="lg"
            onClick={props.onClose}
          >
            {formatMessage({ id: "remoteSync.action.close" })}
          </Button>
        ) : null}
      </div>
    );
  }
  if (activeCategory && activeView) {
    const selectedCount = activeView.selected.size;
    const categoryPushing = activeView.push === "pushing";
    const pushDisabled = props.offline || props.pushing || selectedCount === 0;
    return (
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3 text-ui-base text-foreground-subtle">
          <span data-testid="remote-sync-selection-summary">
            {selectedCount === 0
              ? formatMessage({ id: "remoteSync.selection.empty" })
              : formatMessage({ id: "remoteSync.selection.summary" }, { count: selectedCount })}
          </span>
          {activeView.failedCount > 0 && !categoryPushing ? (
            <span data-testid="remote-sync-failure-summary" className="text-destructive">
              {formatMessage(
                { id: "remoteSync.selection.failed" },
                { count: activeView.failedCount },
              )}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            data-testid="remote-sync-clear"
            variant="secondary"
            size="lg"
            disabled={selectedCount === 0 || props.offline || props.pushing}
            onClick={() => props.onClear(activeCategory.id)}
          >
            {formatMessage({ id: "remoteSync.action.clear" })}
          </Button>
          <Button
            type="button"
            data-testid="remote-sync-push"
            size="lg"
            disabled={pushDisabled}
            onClick={() => props.onPushCategory(activeCategory.id)}
          >
            {categoryPushing ? (
              <>
                <RefreshCw className="size-3.5 animate-spin" aria-hidden="true" />
                {formatMessage({ id: "remoteSync.action.transferring" })}
              </>
            ) : activeView.push !== "idle" ? (
              <>
                <Check className="size-3.5" aria-hidden="true" />
                {formatMessage({ id: "remoteSync.action.transferAgain" })}
              </>
            ) : (
              formatMessage(
                { id: "remoteSync.action.pushCategory" },
                {
                  category: formatMessage({ id: `remoteSync.category.${activeCategory.id}` }),
                },
              )
            )}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
      {!props.pushing ? (
        <Button
          type="button"
          data-testid="remote-sync-close"
          variant="secondary"
          size="lg"
          onClick={props.onClose}
        >
          {formatMessage({ id: "remoteSync.action.close" })}
        </Button>
      ) : null}
      <Button
        type="button"
        data-testid="remote-sync-push-all"
        size="lg"
        disabled={props.offline || props.pushing || !props.hasOverviewSelection}
        onClick={props.onPushAll}
      >
        {props.pushAllState === "pushing" ? (
          <>
            <RefreshCw className="size-3.5 animate-spin" aria-hidden="true" />
            {formatMessage({ id: "remoteSync.action.transferringAll" })}
          </>
        ) : props.pushAllState === "done" ? (
          <>
            <Check className="size-3.5" aria-hidden="true" />
            {formatMessage({ id: "remoteSync.action.transferredAll" })}
          </>
        ) : (
          <>
            <RefreshCw className="size-3.5" aria-hidden="true" />
            {formatMessage({ id: "remoteSync.action.pushAll" })}
          </>
        )}
      </Button>
    </div>
  );
}
