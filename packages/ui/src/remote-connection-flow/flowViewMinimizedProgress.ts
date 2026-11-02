import { profileMatchesRemoteTarget } from "@/lib/remoteConnectionWizard.js";
import { classifyRemoteConnectionError } from "@/lib/remoteConnectionPresentation.js";
import type { RemoteFlowContext } from "./flowContext.js";
export function buildMinimizedProgress(context: RemoteFlowContext) {
  const {
    open,
    minimizedRef,
    openIntentId,
    directoryEpoch,
    currentStep,
    displayTarget,
    recognizedDeviceName,
    activeProfileName,
    visibleConnectionLogs,
    workspaceStepPath,
    errorCode,
    error,
    intl,
    pendingRemoteTarget,
    aliasCredentialsPending,
    backgroundReady,
    recognizedSourceServerId,
    preferredSourceServerId,
    preferredProfileId,
    sourceManagementSnapshot,
    entryEpochRef,
    handleCloseRequest,
    pendingBackgroundCompletion,
    resumeBackground,
    cancelled,
  } = context;
  return !open && minimizedRef.current
    ? {
        operationId: `${openIntentId ?? 0}:${directoryEpoch}`,
        view: currentStep,
        cancelled,
        target: displayTarget,
        name: recognizedDeviceName ?? activeProfileName,
        logs: visibleConnectionLogs,
        ...(workspaceStepPath ? { workspacePath: workspaceStepPath } : {}),
        error: errorCode === "credentials-required" ? "" : error,
        reason: error
          ? intl.formatMessage({
              id: classifyRemoteConnectionError({
                errorCode,
                target: pendingRemoteTarget ?? undefined,
              }).reasonId,
            })
          : "",
        waiting: aliasCredentialsPending || errorCode === "credentials-required",
        ready: backgroundReady,
        sourceServerId: recognizedSourceServerId ?? preferredSourceServerId,
        profileId:
          preferredProfileId ??
          sourceManagementSnapshot?.directory.profiles.find(
            (profile) =>
              pendingRemoteTarget &&
              pendingRemoteTarget.kind !== "server" &&
              profileMatchesRemoteTarget(profile, pendingRemoteTarget),
          )?.profileId,
        onCancel: () => {
          if (entryEpochRef.current === directoryEpoch) void handleCloseRequest();
        },
        onResume: () => {
          if (
            entryEpochRef.current !== directoryEpoch ||
            (backgroundReady && !pendingBackgroundCompletion.current)
          )
            return;
          resumeBackground();
        },
      }
    : null;
}
