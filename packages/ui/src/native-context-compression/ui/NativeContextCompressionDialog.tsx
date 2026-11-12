import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  NativeContextConfiguration,
  NativeContextModelCandidate,
  NativeContextReadController,
  NativeContextTab,
} from "../contract.js";
import type { NativeContextParameterDraftController } from "../app/useParameterDraft.js";
import { formatContextNumber } from "../domain/format.js";
import { NativeContextParameters } from "./NativeContextParameters.js";
import { NativeContextTrends } from "./NativeContextTrends.js";
import { NativeContextRecords } from "./NativeContextRecords.js";
import NativeContextRecentTrend from "./NativeContextRecentTrend.js";
import { NativeContextAttribution } from "./NativeContextAttribution.js";

const TABS: readonly NativeContextTab[] = ["overview", "trends", "records", "parameters"];

export default function NativeContextCompressionDialog({
  open,
  onOpenChange,
  read,
  taskDraft,
  defaultDraft,
  defaultConfiguration,
  defaultsUnavailable,
  modelCandidates,
  tab,
  onTabChange,
  target,
  onTargetChange,
  selectedOperationId,
  onSelectOperation,
  returnToTrends,
  onQuote,
  onCompress,
  canCompress,
  canSetPolicy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  read: NativeContextReadController;
  taskDraft: NativeContextParameterDraftController;
  defaultDraft: NativeContextParameterDraftController;
  defaultConfiguration: NativeContextConfiguration;
  defaultsUnavailable: boolean;
  modelCandidates: readonly NativeContextModelCandidate[];
  tab: NativeContextTab;
  onTabChange: (tab: NativeContextTab) => void;
  target: "task" | "defaults";
  onTargetChange: (target: "task" | "defaults") => void;
  selectedOperationId: string | null;
  onSelectOperation: (id: string, fromTrend?: boolean) => void;
  returnToTrends: boolean;
  onQuote: (ref: string, text: string) => void;
  onCompress: () => void;
  canCompress: boolean;
  canSetPolicy: boolean;
}) {
  const { intl, locale } = useZCodeIntl();
  const status = read.status;
  const configuration = status
    ? {
        schemaVersion: status.policy.schemaVersion,
        mode: status.policy.mode,
        parameters: status.policy.parameters,
      }
    : null;
  const activeTab = target === "defaults" ? "parameters" : tab;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[min(90dvh,58rem)] min-h-0 w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl"
        data-testid="native-context-details"
      >
        <DialogHeader className="shrink-0 border-b border-border px-4 pt-4 pb-3 pr-14">
          <DialogTitle>{intl.formatMessage({ id: "nativeContext.title" })}</DialogTitle>
          <DialogDescription className="text-ui-sm">
            {intl.formatMessage({
              id:
                target === "task"
                  ? "nativeContext.detailsHelp"
                  : "nativeContext.defaultParametersHelp",
            })}
          </DialogDescription>
          <NativeContextAttribution />
          <Select
            value={target}
            onValueChange={(value) => {
              if (value === "task" || value === "defaults") onTargetChange(value);
            }}
          >
            <SelectTrigger
              className="mt-2 min-h-11 w-full min-w-0 sm:w-64"
              aria-label={intl.formatMessage({ id: "nativeContext.editScope" })}
              data-testid="native-context-scope"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="task">
                {intl.formatMessage({ id: "nativeContext.currentTask" })}
              </SelectItem>
              <SelectItem value="defaults">
                {intl.formatMessage({ id: "nativeContext.newTaskDefaults" })}
              </SelectItem>
            </SelectContent>
          </Select>
        </DialogHeader>
        <Tabs
          value={activeTab}
          onValueChange={(value) => {
            if (TABS.includes(value as NativeContextTab)) onTabChange(value as NativeContextTab);
          }}
          className="min-h-0 flex-1 gap-0"
        >
          {/* 原因：共享 Tabs 的 horizontal 高度 variant 会覆盖普通 h-*；本页需完整容纳 44px 按钮及内边距。 */}
          <TabsList className="grid h-14 w-full shrink-0 grid-cols-4 gap-0 rounded-none border-b border-border bg-surface p-1 group-data-horizontal/tabs:h-14">
            {TABS.map((item) => (
              <TabsTrigger
                key={item}
                value={item}
                className="min-h-11 min-w-0 px-1 text-ui-sm sm:text-ui-base"
                disabled={target === "defaults" && item !== "parameters"}
                data-testid={`native-context-tab-${item}`}
              >
                {intl.formatMessage({ id: `nativeContext.tab.${item}` })}
              </TabsTrigger>
            ))}
          </TabsList>
          <div
            className={`min-h-0 flex-1 ${
              activeTab === "parameters"
                ? "flex flex-col overflow-hidden"
                : "overflow-y-auto overscroll-contain px-4 py-4"
            }`}
            data-testid="native-context-detail-scroll"
          >
            {target === "task" && read.unavailable ? (
              <div
                role="status"
                className={`mb-4 flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-lg bg-warning-surface p-3 text-ui-sm text-warning-surface-foreground ${activeTab === "parameters" ? "mx-4 mt-4" : ""}`}
              >
                <span>{intl.formatMessage({ id: "nativeContext.offlineHelp" })}</span>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  onClick={() => void read.refresh()}
                >
                  {intl.formatMessage({ id: "nativeContext.retry" })}
                </Button>
              </div>
            ) : null}
            <TabsContent value="overview" className="m-0">
              <div className="grid gap-3 sm:grid-cols-2">
                <OverviewCard
                  label={intl.formatMessage({ id: "nativeContext.inputBudget" })}
                  value={formatContextNumber(status?.inputBudget, locale)}
                />
                <OverviewCard
                  label={intl.formatMessage({ id: "nativeContext.auto" })}
                  value={intl.formatMessage({
                    id:
                      status?.policy.mode === "auto"
                        ? "nativeContext.enabled"
                        : status
                          ? "nativeContext.manual"
                          : "nativeContext.notCalculated",
                  })}
                />
                <OverviewCard
                  label={intl.formatMessage({ id: "nativeContext.effectiveBlocks" })}
                  value={formatContextNumber(status?.effectiveBlocks, locale)}
                />
                <OverviewCard
                  label={intl.formatMessage({ id: "nativeContext.referencedOutputs" })}
                  value={formatContextNumber(status?.referencedOutputs, locale)}
                />
              </div>
              <p className="mt-3 text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "nativeContext.protectedHelp" })}
              </p>
              <div className="mt-3">
                <NativeContextRecentTrend read={read} onOpenTrends={() => onTabChange("trends")} />
              </div>
              {status?.unavailableReason ? (
                <p className="mt-3 text-ui-sm text-foreground-subtle">
                  {intl.formatMessage({
                    id: `nativeContext.unavailable.${status.unavailableReason}`,
                  })}
                </p>
              ) : null}
              {status?.lastObservation ? (
                <div className="mt-4 rounded-xl border border-border bg-card p-3">
                  <h3 className="text-ui-base font-medium">
                    {intl.formatMessage({ id: "nativeContext.lastRequest" })}
                  </h3>
                  <p className="mt-1 text-ui-sm text-foreground-subtle">
                    #{status.lastObservation.requestSeq} · {status.lastObservation.model.modelId} ·{" "}
                    {intl.formatMessage({
                      id: `nativeContext.requestStatus.${status.lastObservation.status}`,
                    })}
                  </p>
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <OverviewCard
                      label={intl.formatMessage({ id: "nativeContext.beforeEstimate" })}
                      value={formatContextNumber(status.lastObservation.beforeEstimate, locale)}
                    />
                    <OverviewCard
                      label={intl.formatMessage({ id: "nativeContext.afterEstimate" })}
                      value={formatContextNumber(status.lastObservation.afterEstimate, locale)}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    className="mt-2 min-h-11"
                    onClick={() => onTabChange("trends")}
                  >
                    {intl.formatMessage({ id: "nativeContext.viewTrends" })}
                  </Button>
                </div>
              ) : (
                <p className="mt-4 rounded-xl border border-border bg-surface p-4 text-ui-base text-foreground-subtle">
                  {intl.formatMessage({ id: "nativeContext.noHistoryHelp" })}
                </p>
              )}
              {status?.lastOperation ? (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface p-3">
                  <div>
                    <p className="text-ui-base font-medium">
                      {intl.formatMessage({ id: "nativeContext.lastOperation" })}
                    </p>
                    <p className="text-ui-sm text-foreground-subtle">
                      {intl.formatMessage({
                        id: `nativeContext.operationKind.${status.lastOperation.kind}`,
                      })}{" "}
                      ·{" "}
                      {intl.formatMessage({
                        id: `nativeContext.operationStatus.${status.lastOperation.status}`,
                      })}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    onClick={() => onSelectOperation(status.lastOperation!.operationId)}
                  >
                    {intl.formatMessage({ id: "nativeContext.viewRecord" })}
                  </Button>
                </div>
              ) : null}
              <div className="mt-4 flex flex-wrap gap-2">
                {/* 浮层关闭后详情页仍使用同一维护命令；保留相同入口标识供真实点击回归定位。 */}
                <Button
                  type="button"
                  className="min-h-11"
                  disabled={!canCompress}
                  onClick={onCompress}
                  data-testid="native-context-compress-now"
                >
                  {intl.formatMessage({ id: "nativeContext.compressNow" })}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  onClick={() => onTabChange("parameters")}
                >
                  {intl.formatMessage({ id: "nativeContext.adjustParameters" })}
                </Button>
              </div>
            </TabsContent>
            <TabsContent value="trends" className="m-0">
              <NativeContextTrends
                read={read}
                onOpenRecord={(id) => onSelectOperation(id, true)}
                onOpenRecords={() => onTabChange("records")}
                onParameters={() => onTabChange("parameters")}
              />
            </TabsContent>
            <TabsContent value="records" className="m-0">
              <NativeContextRecords
                read={read}
                selectedOperationId={selectedOperationId}
                onSelectOperation={onSelectOperation}
                onQuote={onQuote}
                onReturnToTrends={returnToTrends ? () => onTabChange("trends") : undefined}
              />
            </TabsContent>
            <TabsContent
              value="parameters"
              className="m-0 flex min-h-0 flex-col overflow-hidden data-[state=inactive]:hidden"
            >
              <NativeContextParameters
                controller={target === "task" ? taskDraft : defaultDraft}
                applied={target === "task" ? configuration : defaultConfiguration}
                defaultConfiguration={defaultConfiguration}
                modelCandidates={modelCandidates}
                unavailable={target === "task" ? !canSetPolicy : defaultsUnavailable}
                target={target}
                onEditDefaults={() => onTargetChange("defaults")}
                inputBudget={target === "task" ? status?.inputBudget : null}
                resolvedToolProtection={
                  target === "task" ? status?.resolvedToolProtection : undefined
                }
              />
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function OverviewCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-card p-3">
      <p className="text-ui-sm text-foreground-subtle">{label}</p>
      <p className="mt-1 break-words font-mono text-ui-lg font-medium">{value}</p>
    </div>
  );
}
