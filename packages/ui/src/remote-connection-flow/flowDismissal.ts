import { type RemoteTarget } from "@zcode/shared";
import { logger } from "@/logger.js";
import type { RemoteFlowContext } from "./flowContext.js";
export function runUpdatePendingRemoteTarget(
  context: RemoteFlowContext,
  target: RemoteTarget | null,
) {
  const { setPendingRemoteTarget, setWslDistro, setWslUser, onFlowTargetChange } = context;

  setPendingRemoteTarget(target);
  // 已保存 WSL 线路曾只更新连接目标，返回配置却使用空值或上一线路的表单。
  // 在接受目标的同一入口回填两项，省略参数也必须清空旧输入。
  if (target?.kind === "wsl") {
    setWslDistro(target.distro ?? "");
    setWslUser(target.user ?? "");
  }
  // 在 onConnect 前同步告知通知层；最小化不清空目标，退出或改选沿用同一清理入口。
  onFlowTargetChange?.(target);
}

export async function runHandleCancelSession(context: RemoteFlowContext, sessionId: string) {
  const { onCancelSession } = context;

  try {
    await onCancelSession(sessionId);
  } catch (sessionError) {
    logger.warn("[SSHDialog] 释放未确认的远程 session 失败:", {
      sessionId,
      error: sessionError,
    });
  }
}

export function runCloseDialog(
  context: RemoteFlowContext,
  options?: { preserveSession?: boolean; keepOpen?: boolean },
) {
  const {
    entryEpochRef,
    setBlockedCompletion,
    setCompletionRunning,
    minimizedRef,
    pendingBackgroundCompletion,
    setBackgroundReady,
    refreshingIntentRef,
    setRefreshingIntent,
    resetDraft,
    setDirectoryPath,
    consumedKindPreferenceRef,
    consumedPreferredSourceServerIdRef,
    consumedPreferredProfileIdRef,
    consumedPreferredTargetRef,
    setAliasCredentialsPending,
    setFocusCredentials,
    connectedSessionIdRef,
    ownsConnectedSessionRef,
    handleCancelSession,
    loading,
    currentStep,
    cancelPendingRemoteConnection,
    connectingRequestId,
    resetFeedback,
    setLoading,
    resetDirectorySelectionState,
    resetConnectionLogs,
    setCurrentStep,
    addingDevice,
    setConnectedSessionId,
    updatePendingRemoteTarget,
    setIdentityLoading,
    setRecognizedDeviceName,
    setRecognizedSourceServerId,
    setActiveProfileName,
    pendingCompletionIntentRef,
    setWorkspaceStepPath,
    updateConnectingRequestId,
    applyOpenState,
  } = context;

  entryEpochRef.current += 1;
  setBlockedCompletion(null);
  setCompletionRunning(false);
  minimizedRef.current = false;
  pendingBackgroundCompletion.current = null;
  setBackgroundReady(false);
  refreshingIntentRef.current = null;
  setRefreshingIntent(false);
  resetDraft();
  setDirectoryPath("");
  consumedKindPreferenceRef.current = null;
  consumedPreferredSourceServerIdRef.current = null;
  consumedPreferredProfileIdRef.current = null;
  consumedPreferredTargetRef.current = null;
  setAliasCredentialsPending(false);
  setFocusCredentials(false);
  // 关闭确认可能早于连接完成，异步确认后必须释放当前 attachment，不能读旧闭包。
  const sessionId = connectedSessionIdRef.current;
  if (!options?.preserveSession && sessionId && ownsConnectedSessionRef.current) {
    void handleCancelSession(sessionId);
  } else if (!options?.preserveSession && loading && currentStep === "connecting") {
    // Bugfix: 连接过程里 sessionId 尚未返回时，关闭弹窗会只重置 UI；这里补上显式取消，确保后台下载同步停止。
    void cancelPendingRemoteConnection(connectingRequestId ?? undefined);
  }
  resetFeedback();
  setLoading(false);
  resetDirectorySelectionState();
  resetConnectionLogs();
  setCurrentStep(addingDevice ? "settings" : "device");
  setConnectedSessionId(null);
  ownsConnectedSessionRef.current = false;
  updatePendingRemoteTarget(null);
  setIdentityLoading(false);
  setRecognizedDeviceName(undefined);
  setRecognizedSourceServerId(undefined);
  setActiveProfileName(undefined);
  pendingCompletionIntentRef.current = {};
  // Bug 原因：SSHDialog 常驻挂载，关闭时不清空会让下一次连接沿用上一次的“打开项目目录”这一步。
  setWorkspaceStepPath(undefined);
  updateConnectingRequestId(null);
  if (!options?.keepOpen) applyOpenState(false);
}

export async function runConfirmRemoteFlowDiscard(context: RemoteFlowContext) {
  const { currentStep, loading, confirmDialog, intl, connectedSessionId } = context;

  if (currentStep === "connecting" && loading) {
    return confirmDialog({
      title: intl.formatMessage({ id: "remote.connectingConfirmTitle" }),
      description: intl.formatMessage({
        id: "remote.connectingConfirmDescription",
      }),
      confirmLabel: intl.formatMessage({ id: "remote.stopConnecting" }),
      cancelLabel: intl.formatMessage({ id: "common.cancel" }),
    });
  }
  if (!connectedSessionId) {
    return true;
  }
  return confirmDialog({
    title: intl.formatMessage({ id: "remote.connectedConfirmTitle" }),
    description: intl.formatMessage({
      id: "remote.connectedConfirmDescription",
    }),
    confirmLabel: intl.formatMessage({ id: "remote.leaveConnectedSession" }),
    cancelLabel: intl.formatMessage({ id: "common.cancel" }),
  });
}

export async function runWithConfirmedDiscard(
  context: RemoteFlowContext,
  discard: () => void | Promise<void>,
) {
  const { entryEpochRef, setDiscardPending, confirmRemoteFlowDiscard } = context;

  const epoch = entryEpochRef.current;
  setDiscardPending(true);
  try {
    const confirmed = await confirmRemoteFlowDiscard();
    if (confirmed && entryEpochRef.current === epoch) await discard();
  } finally {
    setDiscardPending(false);
  }
}
