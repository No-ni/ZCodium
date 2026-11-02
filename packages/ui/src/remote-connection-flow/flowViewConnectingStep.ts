import { type ComponentProps } from "react";
import {
  RemoteConnectionConnectingStep,
  formatDeviceCardMeta,
} from "@/RemoteConnectionDialogContent.js";
import type { RemoteFlowContext } from "./flowContext.js";
export function buildConnectingStep(context: RemoteFlowContext) {
  const {
    addingDevice,
    intl,
    handleCloseRequest,
    closeDialog,
    consumedKindPreferenceRef,
    preferredKind,
    preferredWslDistro,
    consumedPreferredSourceServerIdRef,
    preferredSourceServerId,
    consumedPreferredProfileIdRef,
    preferredProfileId,
    consumedPreferredTargetRef,
    preferredTarget,
    onProjectIntentCleared,
    needsCredentials,
    passphraseRequired,
    privateKeyPassphrase,
    password,
    setPrivateKeyPassphrase,
    setPassword,
    pendingRemoteTarget,
    pendingCompletionIntentRef,
    setAliasCredentialsPending,
    startRemoteConnection,
    minimizedRef,
    applyOpenState,
    visibleConnectionLogs,
    error,
    errorCode,
    rawError,
    cancelled,
    handleCancelConnection,
    loading,
    identityLoading,
    connectedSessionId,
    workspaceStepPath,
    setCurrentStep,
    recognizedDeviceName,
    activeProfileName,
    recognizedServer,
    withConfirmedDiscard,
    entryEpochRef,
    setBlockedCompletion,
    setCompletionRunning,
    connectedSessionIdRef,
    ownsConnectedSessionRef,
    handleCancelSession,
    setConnectedSessionId,
    activeRequestIdRef,
    cancelPendingRemoteConnection,
    connectingRequestId,
    setLoading,
    setFocusCredentials,
    resetFeedback,
    updateConnectingRequestId,
    handleRetryConnection,
  } = context;
  return {
    backToDevicesLabel: addingDevice
      ? intl.formatMessage({ id: "settings.source.newConnection" })
      : undefined,
    onClose: () => {
      void handleCloseRequest();
    },
    onBackToDevices: () => {
      closeDialog({ keepOpen: true });
      // 返回列表不是重开同一外部入口，不能立即再次消费仍在 props 中的偏好。
      consumedKindPreferenceRef.current = preferredKind
        ? `${preferredKind}:${preferredWslDistro ?? ""}`
        : null;
      consumedPreferredSourceServerIdRef.current = preferredSourceServerId ?? null;
      consumedPreferredProfileIdRef.current = preferredProfileId ?? null;
      consumedPreferredTargetRef.current = preferredTarget ?? null;
      onProjectIntentCleared?.();
    },
    credentials: needsCredentials
      ? {
          passphrase: passphraseRequired,
          value: passphraseRequired ? privateKeyPassphrase : password,
          onChange: passphraseRequired ? setPrivateKeyPassphrase : setPassword,
          onSubmit: () => {
            if (pendingRemoteTarget?.kind !== "ssh") return;
            const value = passphraseRequired ? privateKeyPassphrase : password;
            if (!value) return;
            const target = {
              ...pendingRemoteTarget,
              ...(passphraseRequired ? { privateKeyPassphrase: value } : { password: value }),
            };
            const intent = pendingCompletionIntentRef.current;
            setAliasCredentialsPending(false);
            void startRemoteConnection(target, intent.preferredDirectoryPath, intent.options);
          },
        }
      : undefined,
    onMinimize: () => {
      minimizedRef.current = true;
      applyOpenState(false);
    },
    logs: visibleConnectionLogs,
    errorMessage: error,
    errorCode: errorCode,
    rawError: rawError,
    cancelled: cancelled,
    onCancelConnection: handleCancelConnection,
    loading: loading || identityLoading,
    // 带项目目录时，设备连上不算完成；成功打开目录后向导直接关闭，连接屏不会显示全部完成。
    connectionReady: Boolean(connectedSessionId) && !error && !workspaceStepPath,
    workspacePath: workspaceStepPath,
    onContinueToDirectory: () => setCurrentStep("directory"),
    recognizedDeviceName: recognizedDeviceName,
    profileName: activeProfileName,
    recognizedDeviceMeta: recognizedServer ? formatDeviceCardMeta(recognizedServer) : undefined,
    onBack: () => {
      void withConfirmedDiscard(async () => {
        const epoch = ++entryEpochRef.current;
        setBlockedCompletion(null);
        setCompletionRunning(false);
        const sessionId = connectedSessionIdRef.current;
        if (sessionId && ownsConnectedSessionRef.current) void handleCancelSession(sessionId);
        setConnectedSessionId(null);
        activeRequestIdRef.current = null;
        if (loading) {
          await cancelPendingRemoteConnection(connectingRequestId ?? undefined);
          if (entryEpochRef.current !== epoch) return;
          setLoading(false);
        }
        setFocusCredentials(errorCode === "credentials-required");
        resetFeedback();
        updateConnectingRequestId(null);
        setCurrentStep("settings");
      });
    },
    onRetry: handleRetryConnection,
  } satisfies ComponentProps<typeof RemoteConnectionConnectingStep>;
}
