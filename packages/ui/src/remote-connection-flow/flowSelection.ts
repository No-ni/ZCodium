import type { RemoteConnectionOpenPreference } from "@/app-shell/types.js";
import { type RemoteTarget } from "@zcode/shared";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { buildRemoteTarget } from "@/lib/remoteConnectionWizard.js";
import { getRemoteConnectionDirectoryFailureState } from "@/lib/remoteConnectionDialogState.js";
import { formatRemoteConnectionError } from "@/lib/remoteConnectionPresentation.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import type { RemoteFlowContext } from "./flowContext.js";
import type { RemoteConnectionCompletionIntent } from "./completionIntent.js";
export async function runHandleConnect(context: RemoteFlowContext) {
  const {
    loading,
    intl,
    formSnapshot,
    setValidationAttempt,
    resetFeedback,
    setAliasCredentialsPending,
    updatePendingRemoteTarget,
    setActiveProfileName,
    selectedSshConfigAlias,
    startRemoteConnection,
    pendingCompletionIntentRef,
  } = context;

  if (loading) {
    // Bugfix: React 还没来得及把按钮置 disabled 时，快速重复点击会启动多个 SSH host process。
    // 这里在事件入口再做一次并发保护，避免同一个 dialog 产生多条部署流并把上传进度混在一起。
    return;
  }

  const { target: nextTarget } = buildRemoteTarget(intl, formSnapshot);
  if (!nextTarget) {
    // Bugfix: 必填项缺失属于表单校验，不应该和真实连接失败共用顶部错误条。
    // 错误改为显示在对应字段下方（RDUX-27），这里只记录一次失败提交。
    setValidationAttempt((attempt) => attempt + 1);
    return;
  }

  resetFeedback();
  setAliasCredentialsPending(false);
  updatePendingRemoteTarget(nextTarget);
  setActiveProfileName(selectedSshConfigAlias?.trim() || undefined);
  // 手动设备连接完成后统一选目录；已有项目保持原来的明确目录意图。
  await startRemoteConnection(
    nextTarget,
    // 外部偏好只在入口初始化；重新读取 props 会让「新建连接」复活旧设备目录。
    pendingCompletionIntentRef.current.preferredDirectoryPath,
    {
      ...pendingCompletionIntentRef.current.options,
      directToDirectory: true,
    },
  );
}

export function runHandleCancelConnection(context: RemoteFlowContext) {
  const {
    completion,
    onCancelled,
    minimizedRef,
    closeDialog,
    activeRequestIdRef,
    entryEpochRef,
    setBlockedCompletion,
    setCompletionRunning,
    connectedSessionIdRef,
    ownsConnectedSessionRef,
    handleCancelSession,
    setConnectedSessionId,
    updateConnectingRequestId,
    setLoading,
    setIdentityLoading,
    setAliasCredentialsPending,
    resetFeedback,
    setCancelled,
    cancelPendingRemoteConnection,
  } = context;

  if (completion === "device-management" && onCancelled) {
    const background = minimizedRef.current;
    closeDialog();
    onCancelled(background);
    return;
  }
  const requestId = activeRequestIdRef.current;
  entryEpochRef.current += 1;
  setBlockedCompletion(null);
  setCompletionRunning(false);
  const sessionId = connectedSessionIdRef.current;
  if (sessionId && ownsConnectedSessionRef.current) void handleCancelSession(sessionId);
  setConnectedSessionId(null);
  updateConnectingRequestId(null);
  setLoading(false);
  // 取消先撤销 epoch，旧身份确认回包不再有权重启连接或清理当前 busy。
  setIdentityLoading(false);
  setAliasCredentialsPending(false);
  resetFeedback();
  setCancelled(true);
  if (requestId) void cancelPendingRemoteConnection(requestId);
}

export function runHandleStartPendingRemoteConnection(context: RemoteFlowContext) {
  const {
    pendingRemoteTarget,
    handleConnect,
    resetFeedback,
    setAliasCredentialsPending,
    pendingCompletionIntentRef,
    startRemoteConnection,
  } = context;

  if (!pendingRemoteTarget) {
    void handleConnect();
    return;
  }

  if (
    pendingRemoteTarget.kind === "ssh" &&
    !pendingRemoteTarget.password &&
    !pendingRemoteTarget.privateKeyPath
  ) {
    resetFeedback();
    setAliasCredentialsPending(true);
    return;
  }
  const intent = pendingCompletionIntentRef.current;
  void startRemoteConnection(pendingRemoteTarget, intent.preferredDirectoryPath, intent.options);
}

export async function runHandleBackToConnection(context: RemoteFlowContext) {
  const {
    connectedSessionId,
    resetFeedback,
    onCancelSession,
    setConnectedSessionId,
    updateConnectingRequestId,
    resetConnectionLogs,
    setCurrentStep,
    setError,
  } = context;

  if (!connectedSessionId) {
    return;
  }

  resetFeedback();
  try {
    await onCancelSession(connectedSessionId);
    setConnectedSessionId(null);
    updateConnectingRequestId(null);
    resetConnectionLogs();
    setCurrentStep("settings");
  } catch (sessionError) {
    setError(getErrorMessage(sessionError));
  }
}

export async function runHandleSelectDirectory(context: RemoteFlowContext, path: string) {
  const {
    connectedSessionId,
    selectingDirectoryRef,
    entryEpochRef,
    setSelectingDirectory,
    resetFeedback,
    onSelectProject,
    localWorkspacePath,
    pendingCompletionIntentRef,
    minimizedRef,
    setDirectoryPath,
    resetConnectionLogs,
    setCurrentStep,
    setConnectedSessionId,
    updatePendingRemoteTarget,
    updateConnectingRequestId,
    applyOpenState,
    setError,
    resetDirectorySelectionState,
  } = context;

  if (!connectedSessionId || selectingDirectoryRef.current) {
    return;
  }

  // Bugfix: 选中远程目录后还要做 realpath、provider 同步、session 持久化和任务列表刷新。
  // 这些异步步骤之前没有独立的提交中状态，用户会看到按钮无响应；这里在入口设置状态并用 ref 防重复提交。
  const epoch = entryEpochRef.current;
  selectingDirectoryRef.current = true;
  setSelectingDirectory(true);
  resetFeedback();
  try {
    await onSelectProject(connectedSessionId, path, localWorkspacePath);
    if (entryEpochRef.current !== epoch) return;
    pendingCompletionIntentRef.current = {};
    minimizedRef.current = false;
    setDirectoryPath("");
    resetConnectionLogs();
    setCurrentStep("device");
    setConnectedSessionId(null);
    updatePendingRemoteTarget(null);
    updateConnectingRequestId(null);
    applyOpenState(false);
  } catch (selectionError) {
    if (entryEpochRef.current !== epoch) return;
    const failureState = getRemoteConnectionDirectoryFailureState({
      connectedSessionId,
      // 事件处理器只在失败时读取一次最新 snapshot，避免为了回调判断新增重复 Zustand 订阅。
      sessionStillRegistered: Boolean(
        useRemoteWorkspaceSessionStore.getState().sessionsById[connectedSessionId],
      ),
    });
    if (!failureState.connectedSessionId) {
      setConnectedSessionId(null);
      setCurrentStep(failureState.step);
      updateConnectingRequestId(null);
    }
    setError(getErrorMessage(selectionError));
  } finally {
    if (entryEpochRef.current === epoch) resetDirectorySelectionState();
  }
}

export function runAcceptInitialFailure(
  context: RemoteFlowContext,
  target: RemoteTarget,
  initialFailure?: RemoteConnectionOpenPreference["initialFailure"],
) {
  const {
    updatePendingRemoteTarget,
    setKind,
    setHost,
    setPort,
    setUsername,
    setPassword,
    setPrivateKeyPath,
    setPrivateKeyPassphrase,
    setSshAuthMethod,
    setWslDistro,
    setWslUser,
    setDockerContainer,
    setManualDockerContainer,
    setServerUrl,
    setServerName,
    setServerToken,
    setCurrentStep,
    setWorkspaceStepPath,
    resolveWorkspaceStepPath,
    pendingCompletionIntentRef,
    preferredDirectoryPath,
    setErrorCode,
    setRawError,
    setError,
    intl,
  } = context;

  if (!initialFailure) return false;
  if (initialFailure.code === "source-server-upgrade-required" && initialFailure.failedTarget) {
    target = { ...target, ...initialFailure.failedTarget };
  }
  if (
    (initialFailure.code === "source-server-install-required" ||
      initialFailure.code === "source-server-upgrade-required") &&
    target.kind === "wsl"
  ) {
    target = initialFailure.resolvedWslTarget ?? target;
  }
  updatePendingRemoteTarget(target);
  setKind(target.kind);
  if (target.kind === "ssh") {
    setHost(target.host);
    setPort(String(target.port ?? 22));
    setUsername(target.username);
    setPassword(target.password ?? "");
    setPrivateKeyPath(target.privateKeyPath ?? "");
    setPrivateKeyPassphrase(target.privateKeyPassphrase ?? "");
    setSshAuthMethod(target.privateKeyPath ? "privateKey" : "password");
  } else if (target.kind === "wsl") {
    setWslDistro(target.distro ?? "");
    setWslUser(target.user ?? "");
  } else if (target.kind === "docker") {
    setDockerContainer(target.container);
    setManualDockerContainer(target.container);
  } else {
    setServerUrl(target.url);
    setServerName(target.name ?? "");
    setServerToken(target.token ?? "");
  }
  setCurrentStep("connecting");
  setWorkspaceStepPath(
    resolveWorkspaceStepPath(
      pendingCompletionIntentRef.current.preferredDirectoryPath ?? preferredDirectoryPath,
    ),
  );
  setErrorCode(initialFailure.code);
  setRawError(initialFailure.message);
  setError(
    formatRemoteConnectionError({
      fallback: initialFailure.message,
      reasonCode: initialFailure.code,
      formatMessage: intl.formatMessage,
    }),
  );
  return true;
}
