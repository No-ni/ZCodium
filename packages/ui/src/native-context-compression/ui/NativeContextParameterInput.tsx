import {
  getNativeContextParameterValue,
  type NativeContextParameterField,
  type NativeContextParameterValue,
} from "@zcode/shared/native-context-compression";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { Textarea } from "@/components/ui/textarea.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { NativeContextModelCandidate } from "../contract.js";
import type { NativeContextParameterDraftController } from "../app/useParameterDraft.js";
import { parameterText } from "../domain/parameters.js";

export function NativeContextParameterInput({
  field,
  controller,
  disabled,
  invalid,
  modelCandidates,
}: {
  field: NativeContextParameterField;
  controller: NativeContextParameterDraftController;
  disabled: boolean;
  invalid: boolean;
  modelCandidates: readonly NativeContextModelCandidate[];
}) {
  const { intl, locale } = useZCodeIntl();
  if (!controller.draft) return null;
  const value = getNativeContextParameterValue(
    controller.draft.configuration.parameters,
    field.path,
  );
  const text = controller.draft.rawFields[field.path] ?? parameterText(value);
  const label = field.labels[locale];
  const id = `native-context-parameter-${field.path}`;
  const change = (candidate: NativeContextParameterValue) => controller.setValue(field, candidate);
  const optionLabel = (key: string, fallback: string) =>
    field.optionLabels?.[key]?.[locale] ?? fallback;
  if (field.type === "boolean") {
    return (
      <Switch
        id={id}
        data-testid={id}
        aria-label={label}
        checked={value === true}
        disabled={disabled}
        onCheckedChange={change}
      />
    );
  }
  if (field.type === "threshold" && typeof value === "object" && "kind" in value) {
    const ranges = field.thresholdRanges[value.kind];
    return (
      <div className="flex w-full min-w-0 items-center gap-2">
        <Select
          value={value.kind}
          onValueChange={(kind) => {
            if (kind === "percent" || kind === "tokens") change({ kind, value: value.value });
          }}
          disabled={disabled}
        >
          <SelectTrigger
            className="min-h-11 min-w-0 flex-1"
            aria-label={`${label} ${intl.formatMessage({ id: "nativeContext.unit" })}`}
            data-testid={`${id}-unit`}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {field.options?.map(([key, fallback]) => (
              <SelectItem key={key} value={key}>
                {optionLabel(key, fallback)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          id={id}
          data-testid={id}
          aria-label={label}
          aria-invalid={invalid}
          className="min-h-11 w-28 shrink-0 font-mono"
          type="text"
          inputMode="numeric"
          value={text}
          disabled={disabled}
          min={ranges.min}
          max={value.kind === "percent" ? field.thresholdRanges.percent.max : undefined}
          onChange={(event) => controller.setRaw(field, event.target.value)}
        />
      </div>
    );
  }
  if (field.type === "select") {
    return (
      <Select
        value={typeof value === "string" ? value : ""}
        disabled={disabled}
        onValueChange={change}
      >
        <SelectTrigger
          id={id}
          data-testid={id}
          aria-label={label}
          aria-invalid={invalid}
          className="min-h-11 w-full min-w-0"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {field.options?.map(([key, fallback]) => (
            <SelectItem key={key} value={key}>
              {optionLabel(key, fallback)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  if (field.type === "model") {
    const model = typeof value === "object" && "providerId" in value ? value : null;
    const key = model ? JSON.stringify([model.providerId, model.modelId]) : "follow-current";
    const missing =
      !!model &&
      !modelCandidates.some(
        (candidate) =>
          candidate.selection.providerId === model.providerId &&
          candidate.selection.modelId === model.modelId,
      );
    return (
      <div className="space-y-1">
        <Select
          value={key}
          disabled={disabled}
          onValueChange={(selected) => {
            if (selected === "follow-current") change("follow-current");
            else {
              const candidate = modelCandidates.find(
                (item) =>
                  JSON.stringify([item.selection.providerId, item.selection.modelId]) === selected,
              );
              if (candidate) change(candidate.selection);
            }
          }}
        >
          <SelectTrigger
            id={id}
            data-testid={id}
            aria-label={label}
            aria-invalid={invalid || missing}
            className="min-h-11 w-full min-w-0"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="follow-current">
              {intl.formatMessage({ id: "nativeContext.followCurrent" })}
            </SelectItem>
            {missing && model ? (
              <SelectItem value={key} disabled>
                {model.providerId} / {model.modelId}
              </SelectItem>
            ) : null}
            {modelCandidates.map((candidate) => (
              <SelectItem
                key={JSON.stringify([candidate.selection.providerId, candidate.selection.modelId])}
                value={JSON.stringify([
                  candidate.selection.providerId,
                  candidate.selection.modelId,
                ])}
              >
                {candidate.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {missing ? (
          <p className="text-ui-sm text-warning-surface-foreground">
            {intl.formatMessage({ id: "nativeContext.modelUnavailable" })}
          </p>
        ) : null}
      </div>
    );
  }
  if (field.type === "list" && field.options && Array.isArray(value)) {
    return (
      <div
        id={id}
        data-testid={id}
        className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-2"
      >
        {field.options.map(([key, fallback]) => (
          <label key={key} className="flex min-h-11 cursor-pointer items-center gap-2 text-ui-base">
            <Checkbox
              aria-label={optionLabel(key, fallback)}
              disabled={disabled}
              checked={value.some((entry) => entry === key)}
              onCheckedChange={(checked) => {
                const next =
                  checked === true ? [...value, key] : value.filter((entry) => entry !== key);
                if (field.path === "images.sourceKinds") {
                  change(
                    next.filter(
                      (entry): entry is "attachment" | "read" | "bash" | "mcp" =>
                        entry === "attachment" ||
                        entry === "read" ||
                        entry === "bash" ||
                        entry === "mcp",
                    ),
                  );
                }
              }}
            />
            {optionLabel(key, fallback)}
          </label>
        ))}
      </div>
    );
  }
  if (field.type === "text" && field.multiline) {
    return (
      <Textarea
        id={id}
        data-testid={id}
        aria-label={label}
        aria-invalid={invalid}
        className="min-h-28 font-mono text-ui-caption"
        maxLength={field.maxLength}
        value={text}
        disabled={disabled}
        onChange={(event) => change(event.target.value)}
      />
    );
  }
  return (
    <Input
      id={id}
      data-testid={id}
      aria-label={label}
      aria-invalid={invalid}
      className="min-h-11 w-full min-w-0 font-mono"
      type="text"
      inputMode={
        field.type === "number" || field.type === "auto-number"
          ? field.decimal
            ? "decimal"
            : "numeric"
          : "text"
      }
      value={text}
      min={field.min}
      max={field.max}
      maxLength={field.maxLength}
      disabled={disabled}
      placeholder={field.type === "auto-number" ? "auto" : undefined}
      onChange={(event) => {
        if (field.type === "number" || field.type === "auto-number" || field.type === "list")
          controller.setRaw(field, event.target.value);
        else change(event.target.value);
      }}
    />
  );
}
