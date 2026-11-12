import {
  getNativeContextParameterValue,
  type NativeContextConfiguration,
  type NativeContextParameterField,
} from "@zcode/shared/native-context-compression";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { NativeContextModelCandidate } from "../contract.js";
import type { NativeContextParameterDraftController } from "../app/useParameterDraft.js";
import {
  parameterEqualsRecommendation,
  parameterInactiveReason,
  parameterText,
  rawParameterIsValid,
} from "../domain/parameters.js";
import { NativeContextParameterInput } from "./NativeContextParameterInput.js";

export function NativeContextParameterRow({
  field,
  controller,
  applied,
  disabled,
  modelCandidates,
}: {
  field: NativeContextParameterField;
  controller: NativeContextParameterDraftController;
  applied: NativeContextConfiguration | null;
  disabled: boolean;
  modelCandidates: readonly NativeContextModelCandidate[];
}) {
  const { intl, locale } = useZCodeIntl();
  const draft = controller.draft;
  if (!draft) return null;
  const inactive = parameterInactiveReason(draft.configuration, field.path);
  const raw = draft.rawFields[field.path];
  const invalid =
    [...controller.issuePaths].some(
      (path) => path === field.path || path.startsWith(`${field.path}.`),
    ) ||
    (raw !== undefined && !rawParameterIsValid(field, raw));
  const effective = applied
    ? parameterText(getNativeContextParameterValue(applied.parameters, field.path))
    : "—";
  return (
    <div
      className={`grid min-w-0 gap-2 py-3 ${field.multiline ? "" : "sm:grid-cols-[minmax(0,1fr)_minmax(12rem,0.8fr)]"}`}
    >
      <div className="min-w-0">
        <label
          htmlFor={`native-context-parameter-${field.path}`}
          className="text-ui-base font-medium"
        >
          {field.labels[locale]}
        </label>
        {field.helpLabels ? (
          <p className="mt-1 text-ui-sm text-foreground-subtle">{field.helpLabels[locale]}</p>
        ) : null}
        <p className="mt-1 break-words text-ui-xs text-foreground-subtle" title={effective}>
          {intl.formatMessage({ id: "nativeContext.effectiveValue" })}:{" "}
          <span className="font-mono">
            {effective.length > 100 ? `${effective.slice(0, 100)}…` : effective}
          </span>
        </p>
        {inactive ? (
          <p className="mt-1 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: `nativeContext.inactive.${inactive}` })}
          </p>
        ) : null}
      </div>
      <div className="min-w-0">
        <NativeContextParameterInput
          field={field}
          controller={controller}
          disabled={disabled || inactive !== null}
          invalid={invalid}
          modelCandidates={modelCandidates}
        />
        <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
          {invalid ? (
            <span role="alert" className="text-ui-sm text-destructive">
              {intl.formatMessage({ id: "nativeContext.fieldInvalid" })}
            </span>
          ) : (
            <span className="text-ui-xs text-foreground-subtle">
              {intl.formatMessage({
                id: parameterEqualsRecommendation(draft.configuration, field)
                  ? "nativeContext.recommended"
                  : "nativeContext.custom",
              })}
            </span>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-11 text-ui-sm"
            disabled={disabled}
            onClick={() =>
              controller.setValue(
                field,
                Array.isArray(field.value) ? [...field.value] : field.value,
              )
            }
            aria-label={`${field.labels[locale]}: ${intl.formatMessage({ id: "nativeContext.restoreField" })}`}
          >
            {intl.formatMessage({ id: "nativeContext.restoreField" })}
          </Button>
        </div>
      </div>
    </div>
  );
}
