import { useState } from "react";
import {
  NATIVE_CONTEXT_PARAMETER_FIELDS,
  nativeContextConfigurationSchema,
  type NativeContextConfiguration,
  type NativeContextParameterGroup,
  type NativeContextResolvedToolProtection,
} from "@zcode/shared/native-context-compression";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { Textarea } from "@/components/ui/textarea.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { NativeContextModelCandidate } from "../contract.js";
import type { NativeContextParameterDraftController } from "../app/useParameterDraft.js";
import { NativeContextParameterRow } from "./NativeContextParameterRow.js";
import { NativeContextToolProtection } from "./NativeContextToolProtection.js";
import { formatContextNumber } from "../domain/format.js";

const GROUPS: readonly NativeContextParameterGroup[] = [
  "trigger",
  "history",
  "tools",
  "images",
  "prompts",
];

export function NativeContextParameters({
  controller,
  applied,
  modelCandidates = [],
  unavailable,
  target,
  defaultConfiguration,
  onEditDefaults,
  inputBudget,
  resolvedToolProtection,
}: {
  controller: NativeContextParameterDraftController;
  applied: NativeContextConfiguration | null;
  modelCandidates?: readonly NativeContextModelCandidate[];
  unavailable: boolean;
  target: "task" | "defaults";
  defaultConfiguration?: NativeContextConfiguration;
  onEditDefaults?: () => void;
  inputBudget?: number | null;
  resolvedToolProtection?: NativeContextResolvedToolProtection;
}) {
  const { intl, locale } = useZCodeIntl();
  const platform = usePlatform();
  const [exportFailed, setExportFailed] = useState(false);
  const draft = controller.draft;
  if (!draft)
    return (
      <p className="px-4 py-4 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "nativeContext.loading" })}
      </p>
    );
  const disabled = controller.saving || draft.jsonPending;
  const trigger = draft.configuration.parameters.trigger;
  const resolveThreshold = (value: typeof trigger.start) =>
    value.kind === "tokens"
      ? value.value
      : inputBudget == null
        ? null
        : Math.floor((inputBudget * value.value) / 100);
  const exportConfiguration = async () => {
    if (!controller.valid || !platform.saveFile) return;
    const parsed = nativeContextConfigurationSchema.safeParse(draft.configuration);
    if (!parsed.success) return;
    try {
      const data = await new Blob([JSON.stringify(parsed.data, null, 2)], {
        type: "application/json",
      }).arrayBuffer();
      const result = await platform.saveFile({
        data,
        suggestedName: "native-context-compression.json",
      });
      setExportFailed(!result.success && !result.canceled);
    } catch {
      setExportFailed(true);
    }
  };
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      data-testid={`native-context-parameters-${target}`}
      data-unavailable={unavailable}
      data-applied={applied !== null}
    >
      {/* 原因：sticky 底栏曾覆盖原生滚入的 summary；正文独立滚动，底栏按真实高度占位。 */}
      <div
        className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4"
        data-testid="native-context-parameter-scroll"
      >
        <div className="rounded-xl border border-border bg-surface p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-ui-base font-medium">
                {intl.formatMessage({
                  id:
                    target === "task"
                      ? "nativeContext.taskParameters"
                      : "nativeContext.defaultParameters",
                })}
              </p>
              <p className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage({
                  id:
                    target === "task"
                      ? "nativeContext.taskParametersHelp"
                      : "nativeContext.defaultParametersHelp",
                })}
              </p>
            </div>
            <label className="flex min-h-11 items-center gap-2 text-ui-base">
              {intl.formatMessage({ id: "nativeContext.auto" })}
              <Switch
                data-testid="native-context-parameter-mode"
                aria-label={intl.formatMessage({ id: "nativeContext.auto" })}
                disabled={disabled}
                checked={draft.configuration.mode === "auto"}
                onCheckedChange={(enabled) => controller.setMode(enabled ? "auto" : "manual")}
              />
            </label>
          </div>
          {target === "task" && defaultConfiguration ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={disabled}
                onClick={() => controller.load(defaultConfiguration)}
                data-testid="native-context-adopt-defaults"
              >
                {intl.formatMessage({ id: "nativeContext.adoptDefaults" })}
              </Button>
              {onEditDefaults ? (
                <Button type="button" variant="ghost" className="min-h-11" onClick={onEditDefaults}>
                  {intl.formatMessage({ id: "nativeContext.editDefaults" })}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
        <div
          className="rounded-xl border border-border bg-surface p-3 text-ui-sm text-foreground-subtle"
          data-testid="native-context-budget-preview"
        >
          <p>
            {intl.formatMessage(
              { id: "nativeContext.parameterBudget" },
              {
                budget: formatContextNumber(inputBudget, locale),
                start: formatContextNumber(resolveThreshold(trigger.start), locale),
                target: formatContextNumber(resolveThreshold(trigger.target), locale),
              },
            )}
          </p>
          <p className="mt-1">
            {intl.formatMessage({
              id:
                inputBudget == null
                  ? "nativeContext.parameterBudgetUnknown"
                  : "nativeContext.parameterBudgetHelp",
            })}
          </p>
          <p className="mt-1">{intl.formatMessage({ id: "nativeContext.imageModelHelp" })}</p>
        </div>
        {controller.conflict ? (
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-warning-surface p-3 text-ui-base text-warning-surface-foreground"
          >
            <span>{intl.formatMessage({ id: "nativeContext.conflict" })}</span>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={controller.saving}
              onClick={controller.reload}
              data-testid="native-context-reload-parameters"
            >
              {intl.formatMessage({ id: "nativeContext.reloadSaved" })}
            </Button>
          </div>
        ) : null}
        {GROUPS.map((group) => (
          <div key={group} className="space-y-4">
            <section className="overflow-hidden rounded-xl border border-border bg-card">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
                <h3 className="text-ui-base font-medium">
                  {intl.formatMessage({ id: `nativeContext.group.${group}` })}
                </h3>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="min-h-11 text-ui-sm"
                  disabled={disabled}
                  onClick={() => controller.restore(group)}
                  data-testid={`native-context-restore-${group}`}
                >
                  {intl.formatMessage({ id: "nativeContext.restoreGroup" })}
                </Button>
              </div>
              <div className="divide-y divide-border px-3">
                {NATIVE_CONTEXT_PARAMETER_FIELDS.filter(
                  (field) => field.group === group && !field.advanced,
                ).map((field) => (
                  <NativeContextParameterRow
                    key={field.path}
                    field={field}
                    controller={controller}
                    applied={applied}
                    disabled={disabled}
                    modelCandidates={modelCandidates}
                  />
                ))}
              </div>
              <details
                className="border-t border-border px-3"
                data-testid={`native-context-advanced-${group}`}
              >
                <summary className="flex min-h-11 cursor-pointer items-center text-ui-sm text-foreground-subtle">
                  {intl.formatMessage({ id: "nativeContext.advanced" })}
                </summary>
                <div className="divide-y divide-border">
                  {NATIVE_CONTEXT_PARAMETER_FIELDS.filter(
                    (field) => field.group === group && field.advanced,
                  ).map((field) => (
                    <NativeContextParameterRow
                      key={field.path}
                      field={field}
                      controller={controller}
                      applied={applied}
                      disabled={disabled}
                      modelCandidates={modelCandidates}
                    />
                  ))}
                </div>
              </details>
            </section>
            {target === "task" && group === "history" ? (
              <NativeContextToolProtection protection={resolvedToolProtection} />
            ) : null}
          </div>
        ))}
        <details
          className="rounded-xl border border-border bg-surface p-3"
          data-testid="native-context-complete-editor"
        >
          <summary className="flex min-h-11 cursor-pointer items-center text-ui-base font-medium">
            {intl.formatMessage({ id: "nativeContext.completeConfiguration" })}
          </summary>
          <p className="mb-2 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "nativeContext.jsonHelp" })}
          </p>
          <Textarea
            data-testid="native-context-configuration-json"
            aria-label={intl.formatMessage({ id: "nativeContext.completeConfiguration" })}
            aria-invalid={draft.jsonError}
            value={draft.jsonText}
            maxLength={128000}
            className="max-h-96 min-h-56 overflow-auto font-mono text-ui-caption"
            disabled={controller.saving}
            onChange={(event) => controller.setJsonText(event.target.value)}
          />
          {/* 原因：英文恢复标签曾被共享 Button 的单行样式撑出窄屏；动作按完整文字换行并保留命中高度。 */}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-auto min-h-11 min-w-0 max-w-full whitespace-normal"
              disabled={controller.saving}
              onClick={controller.loadJson}
              data-testid="native-context-json-load"
            >
              {intl.formatMessage({ id: "nativeContext.validateLoad" })}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-auto min-h-11 min-w-0 max-w-full whitespace-normal"
              disabled={controller.saving}
              onClick={controller.restoreJson}
              data-testid="native-context-json-restore"
            >
              {intl.formatMessage({ id: "nativeContext.restoreJson" })}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-auto min-h-11 min-w-0 max-w-full whitespace-normal"
              disabled={!controller.valid || !platform.saveFile || controller.saving}
              onClick={() => void exportConfiguration()}
              data-testid="native-context-export-configuration"
            >
              {intl.formatMessage({ id: "nativeContext.exportConfiguration" })}
            </Button>
          </div>
          {draft.jsonPending ? (
            <p
              role="status"
              className="mt-2 text-ui-sm text-warning-surface-foreground"
              data-testid="native-context-json-pending"
            >
              {intl.formatMessage({ id: "nativeContext.jsonPending" })}
            </p>
          ) : null}
          {draft.jsonError ? (
            <p role="alert" className="mt-2 text-ui-sm text-destructive">
              {intl.formatMessage({ id: "nativeContext.jsonInvalid" })}
            </p>
          ) : null}
          {exportFailed ? (
            <p role="alert" className="mt-2 text-ui-sm text-destructive">
              {intl.formatMessage({ id: "nativeContext.exportFailed" })}
            </p>
          ) : null}
        </details>
      </div>
      <div
        className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border bg-popover px-4 py-3"
        data-testid="native-context-parameter-footer"
      >
        <p
          role="status"
          className="min-w-0 text-ui-sm text-foreground-subtle"
          data-testid="native-context-parameter-save-status"
          data-version={draft.baseVersion}
          data-state={
            controller.saving
              ? "saving"
              : controller.saveResult === "error"
                ? "error"
                : controller.saveResult === "saved"
                  ? "saved"
                  : controller.dirty
                    ? "unsaved"
                    : "clean"
          }
        >
          {intl.formatMessage(
            {
              id:
                controller.saveResult === "error"
                  ? "nativeContext.saveFailed"
                  : controller.saveResult === "saved"
                    ? "nativeContext.saved"
                    : controller.dirty
                      ? "nativeContext.unsaved"
                      : "nativeContext.savedVersion",
            },
            { version: draft.baseVersion },
          )}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="ghost"
            className="min-h-11"
            disabled={disabled}
            onClick={() => controller.restore()}
            data-testid="native-context-restore-all"
          >
            {intl.formatMessage({ id: "nativeContext.restoreAll" })}
          </Button>
          <Button
            type="button"
            className="min-h-11"
            disabled={
              unavailable ||
              controller.saving ||
              !controller.dirty ||
              !controller.valid ||
              controller.conflict
            }
            onClick={() => void controller.save()}
            data-testid="native-context-save-parameters"
          >
            {intl.formatMessage({
              id: controller.saving ? "nativeContext.saving" : "nativeContext.saveParameters",
            })}
          </Button>
        </div>
      </div>
    </div>
  );
}
