import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { NativeContextConfiguration, NativeContextModelCandidate } from "../contract.js";
import type { NativeContextParameterDraftController } from "../app/useParameterDraft.js";
import { NativeContextParameters } from "./NativeContextParameters.js";
import { NativeContextAttribution } from "./NativeContextAttribution.js";

export default function NativeContextDefaultsDialog({
  open,
  onOpenChange,
  controller,
  configuration,
  unavailable,
  modelCandidates,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  controller: NativeContextParameterDraftController;
  configuration: NativeContextConfiguration;
  unavailable: boolean;
  modelCandidates: readonly NativeContextModelCandidate[];
}) {
  const { intl } = useZCodeIntl();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[90dvh] min-h-0 w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
        data-testid="native-context-defaults-dialog"
      >
        <DialogHeader className="shrink-0 border-b border-border px-4 pt-4 pb-3 pr-14">
          <DialogTitle>{intl.formatMessage({ id: "nativeContext.defaultParameters" })}</DialogTitle>
          <DialogDescription className="text-ui-sm">
            {intl.formatMessage({ id: "nativeContext.defaultParametersHelp" })}
          </DialogDescription>
          <NativeContextAttribution />
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <NativeContextParameters
            controller={controller}
            applied={configuration}
            unavailable={unavailable}
            target="defaults"
            modelCandidates={modelCandidates}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
