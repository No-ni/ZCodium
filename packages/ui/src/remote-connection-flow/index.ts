import { buildRemoteFlowFormSnapshot } from "./flowViewSettingsStep.js";
import type { RemoteConnectionOpenPreference } from "@/app-shell/types.js";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef } from "react";
import { type ConnectionProfile, type RemoteTarget } from "@zcode/shared";
import { getRemoteWizardStepCopy } from "@/lib/remoteConnectionWizard.js";
import { isRemoteConnectionFlowActive } from "@/lib/remoteConnectionDialogState.js";
import { classifyRemoteConnectionError } from "@/lib/remoteConnectionPresentation.js";
import { formatRemoteLinkRailTarget } from "@/remote-connection/RemoteLinkRail.js";
import { type RemoteConnectionFlowOptions } from "@/remote-connection-flow/contract.js";
import { useRemoteConnectionFlowState } from "./flowState.js";
import type { RemoteFlowContext } from "./flowContext.js";
import type { RemoteConnectionCompletionIntent } from "./completionIntent.js";
import { buildRemoteFlowView } from "./flowView.js";
import {
  runUpdatePendingRemoteTarget,
  runHandleCancelSession,
  runCloseDialog,
  runConfirmRemoteFlowDiscard,
  runWithConfirmedDiscard,
} from "./flowDismissal.js";
import { runStartRemoteConnection } from "./flowConnection.js";
import {
  runHandleConnect,
  runHandleCancelConnection,
  runHandleStartPendingRemoteConnection,
  runHandleBackToConnection,
  runHandleSelectDirectory,
  runAcceptInitialFailure,
} from "./flowSelection.js";
import {
  runHandleSelectProfile,
  runAcceptOpenIntent,
  runApplyPreferredTarget,
  runFlowEffect5,
  runFlowEffect6,
} from "./flowEntry.js";
import { runFlowEffect7, runResumeBackground, runHandleRetryConnection } from "./flowRecovery.js";

export type { RemoteConnectionFlowOptions } from "@/remote-connection-flow/contract.js";

export function useRemoteConnectionFlow(options: RemoteConnectionFlowOptions) {
  const state = useRemoteConnectionFlowState(options, (nextOpen) => applyOpenState(nextOpen));
  const {
    onFlowActiveChange,
    onFlowRequestIdChange,
    onFlowTargetChange,
    activeRequestIdRef,
    setConnectingRequestId,
    selectingDirectoryRef,
    setSelectingDirectory,
    consumedOpenIntentIdRef,
    consumedKindPreferenceRef,
  } = state;
  // Context 只投影 flowState；稳定 getter 避免事件回调冻结上一轮渲染的表单与服务。
  const currentContextRef = useRef<RemoteFlowContext>(null!);
  const getContext = useCallback(() => currentContextRef.current, []);
  const renderContext = (): RemoteFlowContext => ({
    ...state,
    handleCancelSession,
    resetFeedback,
    resetDirectorySelectionState,
    updatePendingRemoteTarget,
    updateConnectingRequestId,
    applyOpenState,
    confirmRemoteFlowDiscard,
    resolveWorkspaceStepPath,
    closeDialog,
    resumeBackground,
    formSnapshot,
    startRemoteConnection,
    handleConnect,
    acceptInitialFailure,
    applyPreferredTarget,
    openPreferredProfile,
    openPreferredSourceDirectory,
    handleOpenChange,
    handleStartPendingRemoteConnection,
    stepCopy,
    handleCloseRequest,
    directoryEpoch,
    displayTarget,
    handleSelectProfile,
    needsCredentials,
    passphraseRequired,
    handleCancelConnection,
    withConfirmedDiscard,
    handleRetryConnection,
    handleSelectDirectory,
    handleBackToConnection,
  });

  const backgroundActive = state.minimizedRef.current;
  useEffect(() => {
    // 后台完成消费后即使 loading/open 都未改变，也必须释放 Root 的入口门禁。
    onFlowActiveChange?.(state.flowActive || backgroundActive);
  }, [state.flowActive, backgroundActive, onFlowActiveChange]);

  const updateConnectingRequestId = useCallback(
    (requestId: string | null) => {
      activeRequestIdRef.current = requestId;
      setConnectingRequestId(requestId);
      onFlowRequestIdChange?.(requestId);
    },
    [activeRequestIdRef, setConnectingRequestId, onFlowRequestIdChange],
  );

  const updatePendingRemoteTarget = useCallback(
    (target: RemoteTarget | null) => {
      return runUpdatePendingRemoteTarget(getContext(), target);
    },
    [getContext],
  );
  useEffect(() => () => onFlowTargetChange?.(null), [onFlowTargetChange]);

  const applyOpenState = (nextOpen: boolean) => {
    state.onOpenChange?.(nextOpen);
    if (state.controlledOpen === undefined) {
      state.setUncontrolledOpen(nextOpen);
    }
  };

  /** 连接成功后由本 flow 打开指定目录时才有“打开项目目录”这一步；设备管理和交给调用方的完成没有。 */
  const resolveWorkspaceStepPath = (path?: string) =>
    state.completion !== "device-management" && !state.onConnectionReady && path?.trim()
      ? path.trim()
      : undefined;

  const resetFeedback = () => {
    state.setCancelled(false);
    state.setError("");
    state.setErrorCode(undefined);
    state.setRawError(undefined);
    state.setValidationAttempt(0);
  };

  const resetDirectorySelectionState = useCallback(() => {
    selectingDirectoryRef.current = false;
    setSelectingDirectory(false);
  }, [selectingDirectoryRef, setSelectingDirectory]);

  const handleCancelSession = useCallback(
    async (sessionId: string) => {
      return runHandleCancelSession(getContext(), sessionId);
    },
    [getContext],
  );

  const closeDialog = useCallback(
    (options?: { preserveSession?: boolean; keepOpen?: boolean }) => {
      return runCloseDialog(getContext(), options);
    },
    [getContext],
  );

  const confirmRemoteFlowDiscard = useCallback(async () => {
    return runConfirmRemoteFlowDiscard(getContext());
  }, [getContext]);

  const withConfirmedDiscard = async (discard: () => void | Promise<void>) => {
    return runWithConfirmedDiscard(getContext(), discard);
  };
  const handleCloseRequest = () =>
    withConfirmedDiscard(() => {
      const background = state.minimizedRef.current;
      closeDialog();
      state.onCancelled?.(background);
    });
  const handleDismissRequest = () => {
    void handleCloseRequest();
  };

  const startRemoteConnection = async (
    target: RemoteTarget,
    preferredDirectoryPath?: string,
    options?: RemoteConnectionCompletionIntent["options"],
  ) => {
    return runStartRemoteConnection(getContext(), target, preferredDirectoryPath, options);
  };

  const formSnapshot = buildRemoteFlowFormSnapshot(state);

  const handleConnect = async () => {
    return runHandleConnect(getContext());
  };

  const handleCancelConnection = useCallback(() => {
    return runHandleCancelConnection(getContext());
  }, [getContext]);

  const handleStartPendingRemoteConnection = useCallback(() => {
    return runHandleStartPendingRemoteConnection(getContext());
  }, [getContext]);

  const handleBackToConnection = useCallback(async () => {
    return runHandleBackToConnection(getContext());
  }, [getContext]);

  const handleSelectDirectory = useCallback(
    async (path: string) => {
      return runHandleSelectDirectory(getContext(), path);
    },
    [getContext],
  );

  const acceptInitialFailure = (
    target: RemoteTarget,
    initialFailure?: RemoteConnectionOpenPreference["initialFailure"],
  ) => {
    return runAcceptInitialFailure(getContext(), target, initialFailure);
  };

  const handleSelectProfile = (
    profile: ConnectionProfile,
    preferredDirectoryPath?: string,
    selectOptions?: {
      initialFailure?: RemoteConnectionOpenPreference["initialFailure"];
      directToDirectory?: boolean;
      localWorkspacePath?: string;
    },
  ) => {
    return runHandleSelectProfile(getContext(), profile, preferredDirectoryPath, selectOptions);
  };
  const acceptOpenIntent = useEffectEvent(() => {
    return runAcceptOpenIntent(getContext());
  });
  const hasActiveConnectionPhase = isRemoteConnectionFlowActive(state.flowSnapshot);
  useEffect(() => {
    if (
      !state.open ||
      state.openIntentId === undefined ||
      consumedOpenIntentIdRef.current === state.openIntentId
    )
      return;
    consumedOpenIntentIdRef.current = state.openIntentId;
    // Root 用 flowActive 拒绝新增意图；显式替换已有 openIntentId 仍需撤销等待中的完成动作。
    if (hasActiveConnectionPhase || state.identityLoading) return;
    acceptOpenIntent();
  }, [
    state.open,
    state.openIntentId,
    state.flowActive,
    hasActiveConnectionPhase,
    state.identityLoading,
    consumedOpenIntentIdRef,
  ]);

  const applyKindPreference = useEffectEvent(() => {
    if (!state.preferredKind || !state.availableKinds.includes(state.preferredKind)) return;
    // 外部 WSL/UNC 意图只在新入口消费一次；恢复收起的表单不能覆盖用户草稿。
    state.resetDraft();
    state.setKind(state.preferredKind);
    if (state.preferredKind === "wsl") state.setWslDistro(state.preferredWslDistro ?? "");
    state.setCurrentStep("settings");
  });
  useEffect(() => {
    if (
      !state.open ||
      !state.preferredKind ||
      state.preferredTarget ||
      state.preferredProfileId ||
      state.preferredSourceServerId
    )
      return;
    const key = `${state.preferredKind}:${state.preferredWslDistro ?? ""}`;
    if (consumedKindPreferenceRef.current === key) return;
    consumedKindPreferenceRef.current = key;
    applyKindPreference();
  }, [
    state.open,
    state.preferredKind,
    state.preferredWslDistro,
    state.preferredTarget,
    state.preferredProfileId,
    state.preferredSourceServerId,
    state.openIntentId,
    consumedKindPreferenceRef,
  ]);

  const applyPreferredTarget = useEffectEvent((target: RemoteTarget) => {
    return runApplyPreferredTarget(getContext(), target);
  });
  const applyFlowEffect5 = useEffectEvent(() => runFlowEffect5(getContext()));
  useEffect(() => {
    return applyFlowEffect5();
  }, [
    state.open,
    state.preferredTarget,
    state.preferredProfileId,
    state.loading,
    state.connectedSessionId,
    state.currentStep,
    state.pendingRemoteTarget,
    state.openIntentId,
  ]);

  const openPreferredSourceDirectory = useEffectEvent((profile: ConnectionProfile) => {
    handleSelectProfile(profile, undefined, { directToDirectory: true });
  });
  const openPreferredProfile = useEffectEvent((profile: ConnectionProfile) => {
    handleSelectProfile(profile, state.preferredDirectoryPath, {
      directToDirectory: true,
      initialFailure: state.initialFailure,
    });
  });

  const applyFlowEffect6 = useEffectEvent(() => runFlowEffect6(getContext()));
  useEffect(() => {
    return applyFlowEffect6();
  }, [
    state.connectedSessionId,
    state.loading,
    state.open,
    state.openIntentId,
    state.preferredProfileId,
    state.refreshingIntent,
    state.sourceManagementSnapshot,
  ]);

  const applyFlowEffect7 = useEffectEvent(() => runFlowEffect7(getContext()));
  useEffect(() => {
    return applyFlowEffect7();
  }, [
    state.connectedSessionId,
    state.loading,
    state.open,
    state.openIntentId,
    state.preferredSourceServerId,
    state.refreshingIntent,
    state.sourceManagementSnapshot,
  ]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      state.minimizedRef.current = false;
      applyOpenState(true);
      return;
    }

    handleDismissRequest();
  };

  const stepCopy = getRemoteWizardStepCopy(state.intl, state.currentStep, state.kind, {
    lineName:
      state.activeProfileName ??
      (state.pendingRemoteTarget
        ? formatRemoteLinkRailTarget(state.pendingRemoteTarget)
        : undefined),
    deviceName: state.recognizedDeviceName,
    connectionReady: Boolean(state.connectedSessionId) && !state.error,
    hasError: Boolean(state.error),
    updating: state.identityLoading,
    cancelled: state.cancelled,
  });

  const credentialCategory = classifyRemoteConnectionError({
    errorCode: state.errorCode,
    error: state.rawError ?? state.error,
  }).category;
  const needsCredentials =
    state.aliasCredentialsPending ||
    credentialCategory === "credentials" ||
    credentialCategory === "authentication";
  const passphraseRequired =
    state.pendingRemoteTarget?.kind === "ssh" && Boolean(state.pendingRemoteTarget.privateKeyPath);
  const resumeBackground = () => {
    return runResumeBackground(getContext());
  };
  const resumeOpenedBackground = useEffectEvent(() => {
    // 普通入口只更新受控 open，曾绕过后台恢复，导致已完成结果挂在没有继续入口的连接页。
    // 复用同一恢复动作：在途时解除后台标记，完成后一次消费结果，保留取消与代际保护。
    if (state.minimizedRef.current) resumeBackground();
  });
  useEffect(() => {
    if (state.open) resumeOpenedBackground();
  }, [state.open]);
  const displayTarget = useMemo(
    () =>
      state.pendingRemoteTarget?.kind === "ssh"
        ? {
            kind: "ssh" as const,
            host: state.pendingRemoteTarget.host,
            username: state.pendingRemoteTarget.username,
            port: state.pendingRemoteTarget.port,
          }
        : state.pendingRemoteTarget?.kind === "server"
          ? {
              kind: "server" as const,
              url: state.pendingRemoteTarget.url,
              name: state.pendingRemoteTarget.name,
            }
          : state.pendingRemoteTarget,
    [state.pendingRemoteTarget],
  );
  const directoryEpoch = state.entryEpochRef.current;
  const handleRetryConnection = () => {
    return runHandleRetryConnection(getContext());
  };

  currentContextRef.current = renderContext();
  return buildRemoteFlowView(currentContextRef.current);
}
