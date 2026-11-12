import { lazy, Suspense, useCallback, useState } from "react";
import type { ModelSelection } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useNativeContextCompression } from "@/hooks/useNativeContextCompression.js";
import {
  useNativeContextCompressionDefaults,
  useNativeContextDefaultModels,
} from "@/hooks/useNativeContextCompressionDefaults.js";
import { useNativeContextDraftStore } from "@/store/nativeContextCompressionDraftStore.js";
import { useParameterDraft } from "../app/useParameterDraft.js";
import { formatContextNumber, nativeContextScopeKey } from "../domain/format.js";
import type {
  NativeContextActions,
  NativeContextConfiguration,
  NativeContextIdentity,
  NativeContextModelCandidate,
  NativeContextStatus,
  NativeContextTab,
} from "../contract.js";

const NativeContextCompressionDialog = lazy(() => import("./NativeContextCompressionDialog.js"));
const NativeContextRecentTrend = lazy(() => import("./NativeContextRecentTrend.js"));

interface NativeContextCompressionEntryProps {
  identity: NativeContextIdentity;
  projection?: NativeContextStatus | null;
  draftConfiguration?: NativeContextConfiguration;
  usage: { usedTokens: number; maxTokens: number } | null;
  currentModel: ModelSelection | null;
  modelCandidates: readonly NativeContextModelCandidate[];
  actions?: NativeContextActions;
  disabled: boolean;
  onQuote: (ref: string, text: string) => void;
  onOpenDefaultsSettings: () => void;
}

export function NativeContextCompressionEntry(props: NativeContextCompressionEntryProps) {
  // 任务切换会复用 Composer；按身份重建浮层，不能把 A 的已打开状态带到 B。
  return <NativeContextScopedEntry key={nativeContextScopeKey(props.identity)} {...props} />;
}

function NativeContextScopedEntry({
  identity,
  projection,
  draftConfiguration,
  usage,
  currentModel,
  modelCandidates,
  actions,
  disabled,
  onQuote,
  onOpenDefaultsSettings,
}: NativeContextCompressionEntryProps) {
  const { intl, locale } = useZCodeIntl();
  // Composer 写操作被锁住时仍可查看数字和记录；读面只遵循 attachment 的可用性。
  const read = useNativeContextCompression(identity, { projection });
  const defaults = useNativeContextCompressionDefaults();
  const status = read.status;
  const taskConfiguration = status
    ? {
        schemaVersion: status.policy.schemaVersion,
        mode: status.policy.mode,
        parameters: status.policy.parameters,
      }
    : identity.sessionId === null && !defaults.unavailable
      ? (draftConfiguration ?? defaults.configuration)
      : null;
  const saveTask = useCallback(
    async (configuration: NativeContextConfiguration, expectedVersion: number) => {
      if (disabled || !actions || !identity.sessionId || read.unavailable)
        throw new Error("native-context-unavailable");
      const ack = await actions.setPolicy(configuration, expectedVersion);
      if (ack.status !== "accepted" && ack.status !== "noop" && ack.status !== "duplicate") {
        await read.refresh();
        throw new Error("native-context-policy-rejected");
      }
      const committed = await read.refresh();
      if (
        !committed ||
        JSON.stringify(committed.policy.parameters) !== JSON.stringify(configuration.parameters) ||
        committed.policy.mode !== configuration.mode
      )
        throw new Error("native-context-policy-unconfirmed");
      return committed.policy.policyVersion;
    },
    [actions, disabled, identity.sessionId, read.refresh, read.unavailable],
  );
  const taskDraft = useParameterDraft({
    scopeKey: read.scopeKey,
    configuration: taskConfiguration,
    version: status?.policy.policyVersion ?? 0,
    onSave: saveTask,
  });
  const defaultDraft = useParameterDraft({
    scopeKey: defaults.scopeKey,
    configuration: defaults.unavailable ? null : defaults.configuration,
    version: defaults.version,
    onSave: defaults.save,
  });
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [target, setTarget] = useState<"task" | "defaults">("task");
  const defaultModels = useNativeContextDefaultModels(dialogOpen && target === "defaults");
  const [actionState, setActionState] = useState<{
    key: string;
    pending: boolean;
    failed: boolean;
  }>({ key: read.scopeKey, pending: false, failed: false });
  const [selectedRecord, setSelectedRecord] = useState<{
    key: string;
    id: string;
    fromTrend: boolean;
  } | null>(null);
  const tab = useNativeContextDraftStore((state) => state.tabs[read.scopeKey]) ?? "overview";
  const selectTab = (selected: NativeContextTab) =>
    useNativeContextDraftStore.getState().selectTab(read.scopeKey, selected);
  const openDetails = (selected: NativeContextTab = "overview") => {
    setPopoverOpen(false);
    setTarget("task");
    selectTab(selected);
    setDialogOpen(true);
  };
  const pending = actionState.key === read.scopeKey && actionState.pending;
  const canWrite =
    !disabled && !read.unavailable && !!actions && !!status && !!identity.sessionId && !pending;
  const canCompress =
    canWrite &&
    status?.phase === "idle" &&
    (status.unavailableReason === null ||
      status.unavailableReason === "busy" ||
      status.unavailableReason === "paused") &&
    !!currentModel;
  const queued = status?.phase === "compressing" && status.lastOperation?.status === "preparing";
  const act = async (action: () => Promise<unknown>) => {
    const key = read.scopeKey;
    setActionState({ key, pending: true, failed: false });
    try {
      await action();
      setActionState({ key, pending: false, failed: false });
    } catch {
      setActionState({ key, pending: false, failed: true });
    }
  };
  const compress = () => {
    if (!canCompress || !actions || !currentModel) return;
    void act(async () => {
      const ack = await actions.compress(currentModel);
      if (ack.status !== "accepted" && ack.status !== "noop" && ack.status !== "duplicate")
        throw new Error("native-context-compression-rejected");
      await read.refresh();
    });
  };
  const windowPercent =
    usage && usage.maxTokens > 0 && Number.isFinite(usage.usedTokens)
      ? Math.max(0, Math.min(100, (usage.usedTokens / usage.maxTokens) * 100))
      : null;
  const label =
    windowPercent === null
      ? intl.formatMessage({ id: "nativeContext.notCalculated" })
      : `${Math.round(windowPercent)}%`;
  return (
    <>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-11 shrink-0 gap-1.5 px-1.5 text-ui-sm text-foreground-subtle sm:min-h-7"
            aria-label={intl.formatMessage({ id: "nativeContext.open" }, { usage: label })}
            data-testid="native-context-entry"
          >
            <svg viewBox="0 0 24 24" className="size-4 shrink-0" aria-hidden="true">
              <circle
                cx="12"
                cy="12"
                r="9"
                fill="none"
                stroke="var(--color-border)"
                strokeWidth="3"
              />
              <circle
                cx="12"
                cy="12"
                r="9"
                fill="none"
                stroke={
                  windowPercent !== null && windowPercent >= 90
                    ? "var(--color-warning)"
                    : "var(--color-foreground-subtle)"
                }
                strokeWidth="3"
                pathLength="100"
                strokeDasharray={`${windowPercent ?? 0} 100`}
                transform="rotate(-90 12 12)"
              />
            </svg>
            <span>
              {status?.phase === "compressing"
                ? intl.formatMessage({
                    id: queued ? "nativeContext.queued" : "nativeContext.compressing",
                  })
                : label}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-80 max-w-[calc(100vw-2rem)] gap-3 p-3"
          data-testid="native-context-popover"
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-ui-base font-medium">
              {intl.formatMessage({ id: "nativeContext.title" })}
            </h2>
            <span className="text-ui-xs text-foreground-subtle">
              {status
                ? `v${status.policy.policyVersion}`
                : intl.formatMessage({ id: "nativeContext.beforeCreation" })}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-ui-xs text-foreground-subtle">
                {intl.formatMessage({ id: "nativeContext.windowUsage" })}
              </p>
              <p className="font-mono text-ui-base">
                {usage
                  ? `${formatContextNumber(usage.usedTokens, locale)} / ${formatContextNumber(usage.maxTokens, locale)}`
                  : "—"}
              </p>
            </div>
            <div>
              <p className="text-ui-xs text-foreground-subtle">
                {intl.formatMessage({ id: "nativeContext.inputBudget" })}
              </p>
              <p className="font-mono text-ui-base">
                {formatContextNumber(status?.inputBudget, locale)}
              </p>
            </div>
          </div>
          <div className="flex min-h-11 items-center justify-between gap-2">
            <label className="text-ui-base" htmlFor="native-context-auto-switch">
              {intl.formatMessage({ id: "nativeContext.auto" })}
            </label>
            <Switch
              id="native-context-auto-switch"
              data-testid="native-context-auto-switch"
              aria-label={intl.formatMessage({ id: "nativeContext.auto" })}
              checked={taskConfiguration?.mode === "auto"}
              disabled={!canWrite || taskDraft.dirty}
              onCheckedChange={(enabled) => {
                if (!status || !taskConfiguration) return;
                void act(async () => {
                  await saveTask(
                    { ...taskConfiguration, mode: enabled ? "auto" : "manual" },
                    status.policy.policyVersion,
                  );
                });
              }}
            />
          </div>
          {taskDraft.dirty ? (
            <p className="text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: "nativeContext.unsavedQuickToggle" })}
            </p>
          ) : null}
          {!identity.sessionId ? (
            <p className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "nativeContext.beforeCreationHelp" })}
            </p>
          ) : status?.unavailableReason ? (
            <p className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: `nativeContext.unavailable.${status.unavailableReason}` })}
            </p>
          ) : null}
          {read.unavailable ? (
            <p role="status" className="text-ui-sm text-warning-surface-foreground">
              {intl.formatMessage({ id: "nativeContext.offlineHelp" })}
            </p>
          ) : null}
          {status?.unavailableReason === "busy" || status?.unavailableReason === "paused" ? (
            <p className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "nativeContext.queueHelp" })}
            </p>
          ) : null}
          {actionState.key === read.scopeKey && actionState.failed ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {intl.formatMessage({ id: "nativeContext.actionFailed" })}
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              className="min-h-11"
              disabled={!canCompress}
              onClick={compress}
              data-testid="native-context-compress-now"
            >
              {intl.formatMessage({ id: "nativeContext.compressNow" })}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={!canWrite || status?.phase !== "idle"}
              onClick={() => {
                actions?.deepCompact();
                setPopoverOpen(false);
              }}
              data-testid="native-context-deep-compact"
            >
              {intl.formatMessage({ id: "nativeContext.deepCompact" })}
            </Button>
          </div>
          {/* 原因：创建前没有 Runtime status；精简趋势仍须挂载已有空态，并由内部围栏阻止查询。 */}
          {popoverOpen ? (
            <Suspense fallback={null}>
              <NativeContextRecentTrend
                read={read}
                onOpenTrends={() => openDetails("trends")}
                compact
              />
            </Suspense>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="ghost"
              className="min-h-11"
              onClick={() => openDetails("trends")}
              data-testid="native-context-open-trends"
            >
              {intl.formatMessage({ id: "nativeContext.viewTrends" })}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="min-h-11"
              onClick={() => openDetails("parameters")}
              data-testid="native-context-open-parameters"
            >
              {intl.formatMessage({ id: "nativeContext.adjustParameters" })}
            </Button>
          </div>
          <Button
            type="button"
            variant="ghost"
            className="min-h-11 w-full text-ui-sm"
            onClick={() => {
              setPopoverOpen(false);
              onOpenDefaultsSettings();
            }}
            data-testid="native-context-defaults-link"
          >
            {intl.formatMessage({ id: "nativeContext.editDefaults" })}
          </Button>
        </PopoverContent>
      </Popover>
      {dialogOpen ? (
        <Suspense fallback={null}>
          <NativeContextCompressionDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            read={read}
            taskDraft={taskDraft}
            defaultDraft={defaultDraft}
            defaultConfiguration={defaults.configuration}
            defaultsUnavailable={defaults.unavailable}
            modelCandidates={target === "task" ? modelCandidates : defaultModels}
            tab={tab}
            onTabChange={selectTab}
            target={target}
            onTargetChange={setTarget}
            selectedOperationId={selectedRecord?.key === read.scopeKey ? selectedRecord.id : null}
            onSelectOperation={(id, fromTrend = false) => {
              setSelectedRecord({ key: read.scopeKey, id, fromTrend });
              selectTab("records");
            }}
            returnToTrends={selectedRecord?.key === read.scopeKey && selectedRecord.fromTrend}
            onQuote={onQuote}
            onCompress={compress}
            canCompress={canCompress}
            canSetPolicy={canWrite}
          />
        </Suspense>
      ) : null}
    </>
  );
}
