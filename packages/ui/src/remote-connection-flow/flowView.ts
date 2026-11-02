import type { RemoteFlowContext } from "./flowContext.js";
import { buildHeader } from "./flowViewHeader.js";
import { buildMinimizedProgress } from "./flowViewMinimizedProgress.js";
import { buildSelectionStep } from "./flowViewSelectionStep.js";
import { buildSettingsStep } from "./flowViewSettingsStep.js";
import { buildConnectingStep } from "./flowViewConnectingStep.js";
import { buildDirectoryStep } from "./flowViewDirectoryStep.js";
export function buildRemoteFlowView(context: RemoteFlowContext) {
  const {
    currentStep,
    open,
    error,
    aliasCredentialsPending,
    setPassword,
    handleConnect,
    password,
    handleOpenChange,
  } = context;
  return {
    open,
    currentStep,
    error,
    handleOpenChange,
    header: buildHeader(context),
    minimizedProgress: buildMinimizedProgress(context),
    aliasCredentials: aliasCredentialsPending
      ? {
          password,
          onPasswordChange: setPassword,
          onSubmit: () => {
            void handleConnect();
          },
        }
      : null,
    selectionStep: buildSelectionStep(context),
    settingsStep: buildSettingsStep(context),
    connectingStep: buildConnectingStep(context),
    directoryStep: buildDirectoryStep(context),
  };
}
