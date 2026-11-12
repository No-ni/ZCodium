import { lazy, Suspense, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import {
  useNativeContextCompressionDefaults,
  useNativeContextDefaultModels,
} from "@/hooks/useNativeContextCompressionDefaults.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useParameterDraft } from "../app/useParameterDraft.js";

const NativeContextDefaultsDialog = lazy(() => import("./NativeContextDefaultsDialog.js"));

export function NativeContextDefaultsSetting() {
  const { intl } = useZCodeIntl();
  const defaults = useNativeContextCompressionDefaults();
  const [open, setOpen] = useState(false);
  const [toggleState, setToggleState] = useState<"idle" | "saving" | "failed">("idle");
  const modelCandidates = useNativeContextDefaultModels(open);
  const controller = useParameterDraft({
    scopeKey: defaults.scopeKey,
    configuration: defaults.unavailable ? null : defaults.configuration,
    version: defaults.version,
    onSave: defaults.save,
  });
  return (
    <>
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "nativeContext.newTaskDefaults" })}
          description={intl.formatMessage({ id: "nativeContext.defaultParametersHelp" })}
          control={
            <div className="flex min-h-11 flex-wrap items-center gap-3">
              <Switch
                data-testid="native-context-default-auto-switch"
                aria-label={intl.formatMessage({ id: "nativeContext.defaultAuto" })}
                checked={defaults.configuration.mode === "auto"}
                disabled={
                  defaults.unavailable ||
                  controller.dirty ||
                  controller.saving ||
                  toggleState === "saving"
                }
                onCheckedChange={(enabled) => {
                  setToggleState("saving");
                  void defaults
                    .save(
                      { ...defaults.configuration, mode: enabled ? "auto" : "manual" },
                      defaults.version,
                    )
                    .then(
                      () => setToggleState("idle"),
                      () => setToggleState("failed"),
                    );
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="min-h-11"
                onClick={() => setOpen(true)}
                data-testid="native-context-defaults-open"
              >
                {intl.formatMessage({ id: "nativeContext.adjustDefaultParameters" })}
              </Button>
            </div>
          }
          detail={
            <div className="space-y-1 text-ui-sm text-foreground-subtle">
              <p>
                {defaults.loading
                  ? intl.formatMessage({ id: "nativeContext.loading" })
                  : defaults.unavailable
                    ? intl.formatMessage({ id: "nativeContext.readFailed" })
                    : intl.formatMessage(
                        { id: "nativeContext.defaultSummary" },
                        {
                          mode: intl.formatMessage({
                            id:
                              defaults.configuration.mode === "auto"
                                ? "nativeContext.auto"
                                : "nativeContext.manual",
                          }),
                          version: defaults.version,
                        },
                      )}
              </p>
              {controller.dirty ? (
                <p>{intl.formatMessage({ id: "nativeContext.unsavedQuickToggle" })}</p>
              ) : null}
              {toggleState === "failed" ? (
                <p role="alert" className="text-destructive">
                  {intl.formatMessage({ id: "nativeContext.saveFailed" })}
                </p>
              ) : null}
            </div>
          }
        />
      </SettingsGroupCard>
      {open ? (
        <Suspense fallback={null}>
          <NativeContextDefaultsDialog
            open={open}
            onOpenChange={setOpen}
            controller={controller}
            configuration={defaults.configuration}
            unavailable={defaults.unavailable}
            modelCandidates={modelCandidates}
          />
        </Suspense>
      ) : null}
    </>
  );
}
